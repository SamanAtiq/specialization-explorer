import os
import json
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
REGION = os.environ["REGION"]

# AWS Clients
bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)

RUNNING_STATUSES = {"STARTING", "IN_PROGRESS", "STOPPING"}

def _response(status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "*",
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

def _update_ingestion_run(connection, *, ingestion_run_id: str, status: str, error_message: str | None):
    with connection.cursor() as cursor:
        if status in {"completed", "failed"}:
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET
                    status = %s::ingestion_status,
                    error_message = %s,
                    completed_at = NOW()
                WHERE id = %s::uuid
                """,
                (status, error_message, ingestion_run_id),
            )
        else:
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET
                    status = %s::ingestion_status,
                    error_message = %s
                WHERE id = %s::uuid
                """,
                (status, error_message, ingestion_run_id),
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
    bedrock_data_source_id = event.get("bedrock_data_source_id")
    bedrock_ingestion_job_id = event.get("bedrock_ingestion_job_id")
    db_ingestion_run_id = event.get("db_ingestion_run_id")
    schedule_name = event.get("schedule_name")

    if not kb_id or not bedrock_data_source_id or not bedrock_ingestion_job_id or not db_ingestion_run_id or not schedule_name:
        return _response(
            400,
            {
                "error": "Missing required scheduler payload fields",
                "received": {
                    "knowledge_base_id": kb_id,
                    "bedrock_data_source_id": bedrock_data_source_id,
                    "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
                    "db_ingestion_run_id": db_ingestion_run_id,
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
        "Polled ingestion job: kb_id=%s data_source_id=%s ingestion_job_id=%s status=%s",
        kb_id,
        bedrock_data_source_id,
        bedrock_ingestion_job_id,
        bedrock_status,
    )

    normalized_status = _normalize_status(bedrock_status)
    if not normalized_status:
        return _response(
            200,
            {
                "message": "Unsupported or unknown Bedrock ingestion status",
                "bedrock_status": bedrock_status,
                "ingestion_job_id": bedrock_ingestion_job_id,
            },
        )

    if normalized_status == "running":
        return _response(
            200,
            {
                "message": "Ingestion job still running",
                "bedrock_status": bedrock_status,
                "ingestion_job_id": bedrock_ingestion_job_id,
            },
        )

    error_message = "; ".join(failure_reasons) if failure_reasons else None

    try:
        rows_updated = _update_ingestion_run(
            connection,
            ingestion_run_id=db_ingestion_run_id,
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
        # DB is already correct; leave schedule cleanup as retriable/manual follow-up

    return _response(
        200,
        {
            "message": "Updated ingestion run and attempted schedule cleanup",
            "db_ingestion_run_id": db_ingestion_run_id,
            "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
            "status": normalized_status,
            "rows_updated": rows_updated,
        },
    )