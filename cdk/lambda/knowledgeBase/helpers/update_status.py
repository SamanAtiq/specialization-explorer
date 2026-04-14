import os
import json
from helpers.cors import get_cors_headers
import logging
import boto3

from helpers.process_s3_batch import process_s3_batch
from helpers.process_website_batch import process_website_batch

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
REGION = os.environ["REGION"]

# AWS Clients
bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)

RUNNING_STATUSES = {"STARTING", "IN_PROGRESS", "STOPPING"}

def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }

def _normalize_status(bedrock_status: str | None) -> str | None:
    if bedrock_status == "COMPLETE":
        return "completed"
    if bedrock_status == "FAILED":
        return "failed"
    if bedrock_status in RUNNING_STATUSES:
        return "running"
    return None

def _update_ingestion_runs(connection, *, ingestion_run_ids: list[str], status: str, error_message: str | None):
    with connection.cursor() as cursor:
        if status in {"completed", "failed"}:
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET
                    status = %s::ingestion_status,
                    error_message = %s,
                    completed_at = NOW()
                WHERE id = ANY(%s::uuid[])
                """,
                (status, error_message, ingestion_run_ids),
            )
        else:
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET
                    status = %s::ingestion_status,
                    error_message = %s
                WHERE id = ANY(%s::uuid[])
                """,
                (status, error_message, ingestion_run_ids),
            )

        return cursor.rowcount

def _delete_schedule(schedule_name: str):
    scheduler_client.delete_schedule(
        Name=schedule_name,
        GroupName="default",
    )

def update_status(event, connection):
    logger.info("Scheduler polling event: %s", json.dumps(event))

    kb_id = event.get("knowledge_base_id")
    phase = event.get("phase")
    sync_session_id = event.get("sync_session_id")
    bedrock_data_source_id = event.get("bedrock_data_source_id")
    bedrock_ingestion_job_id = event.get("bedrock_ingestion_job_id")
    db_ingestion_run_ids = event.get("db_ingestion_run_ids")
    schedule_name = event.get("schedule_name")

    if not isinstance(db_ingestion_run_ids, list) or not db_ingestion_run_ids:
        single_id = event.get("db_ingestion_run_id")
        if single_id:
            db_ingestion_run_ids = [single_id]

    if (
        not kb_id
        or not phase
        or not sync_session_id
        or not bedrock_data_source_id
        or not bedrock_ingestion_job_id
        or not db_ingestion_run_ids
        or not schedule_name
    ):
        return _response(
            event,
            400,
            {
                "error": "Missing required scheduler payload fields",
                "received": {
                    "knowledge_base_id": kb_id,
                    "phase": phase,
                    "sync_session_id": sync_session_id,
                    "bedrock_data_source_id": bedrock_data_source_id,
                    "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
                    "db_ingestion_run_ids": db_ingestion_run_ids,
                    "schedule_name": schedule_name,
                },
            },
        )

    resp = bedrock_agent.get_ingestion_job(
        knowledgeBaseId=kb_id,
        dataSourceId=bedrock_data_source_id,
        ingestionJobId=bedrock_ingestion_job_id,
    )
    ingestion_job = resp.get("ingestionJob", {})
    bedrock_status = ingestion_job.get("status")
    failure_reasons = ingestion_job.get("failureReasons", []) or []

    logger.info(
        "Polled ingestion job: kb_id=%s phase=%s sync_session_id=%s data_source_id=%s ingestion_job_id=%s status=%s",
        kb_id,
        phase,
        sync_session_id,
        bedrock_data_source_id,
        bedrock_ingestion_job_id,
        bedrock_status,
    )

    normalized_status = _normalize_status(bedrock_status)
    if not normalized_status:
        return _response(
            event,
            200,
            {
                "message": "Unsupported or unknown Bedrock ingestion status",
                "phase": phase,
                "sync_session_id": sync_session_id,
                "bedrock_status": bedrock_status,
                "ingestion_job_id": bedrock_ingestion_job_id,
            },
        )

    if normalized_status == "running":
        return _response(
            event,
            200,
            {
                "message": "Ingestion job still running",
                "phase": phase,
                "sync_session_id": sync_session_id,
                "bedrock_status": bedrock_status,
                "ingestion_job_id": bedrock_ingestion_job_id,
            },
        )

    error_message = "; ".join(failure_reasons) if failure_reasons else None

    try:
        rows_updated = _update_ingestion_runs(
            connection,
            ingestion_run_ids=db_ingestion_run_ids,
            status=normalized_status,
            error_message=error_message,
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise

    try:
        _delete_schedule(schedule_name)
    except Exception as e:
        logger.error("Failed to delete schedule %s: %s", schedule_name, e, exc_info=True)

    next_step = None

    if normalized_status == "completed":
        try:
            if phase == "s3":
                next_step = process_website_batch(
                    event=event,
                    connection=connection,
                    kb_id=kb_id,
                    sync_session_id=sync_session_id,
                    triggered_by_scheduler=True,
                )
            elif phase == "website":
                next_step = process_website_batch(
                    event=event,
                    connection=connection,
                    kb_id=kb_id,
                    sync_session_id=sync_session_id,
                    triggered_by_scheduler=True,
                )
        except Exception as e:
            logger.error(
                "Failed to continue sync session %s after phase %s: %s",
                sync_session_id,
                phase,
                e,
                exc_info=True,
            )
            next_step = {
                "started": False,
                "error": str(e),
            }

    return _response(
        event,
        200,
        {
            "message": "Updated ingestion runs and attempted schedule cleanup",
            "phase": phase,
            "sync_session_id": sync_session_id,
            "db_ingestion_run_ids": db_ingestion_run_ids,
            "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
            "status": normalized_status,
            "rows_updated": rows_updated,
            "next_step": next_step,
        },
    )