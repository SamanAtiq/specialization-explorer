import os
import json
from helpers.cors import get_cors_headers
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]
SCHEDULER_ROLE_ARN = os.environ["SCHEDULER_ROLE_ARN"]
SCHEDULER_TARGET_ARN = os.environ["SCHEDULER_TARGET_ARN"]

bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)
s3_client = boto3.client("s3", region_name=REGION)


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }


def _list_all_data_sources(knowledge_base_id: str) -> list[dict]:
    items = []
    next_token = None

    while True:
        kwargs = {
            "knowledgeBaseId": knowledge_base_id,
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        resp = bedrock_agent.list_data_sources(**kwargs)
        items.extend(resp.get("dataSourceSummaries", []))
        next_token = resp.get("nextToken")

        if not next_token:
            break

    return items


def _get_data_source(knowledge_base_id: str, data_source_id: str) -> dict:
    resp = bedrock_agent.get_data_source(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
    )
    return resp["dataSource"]


def _is_s3_data_source(data_source: dict) -> bool:
    return data_source.get("dataSourceConfiguration", {}).get("type") == "S3"


def _validate_file_pair(csv_file_name: str, metadata_file_name: str) -> str | None:
    if not csv_file_name.endswith(".csv"):
        return "csv_file_name must end with .csv"

    if not metadata_file_name.endswith(".json"):
        return "metadata_file_name must end with .json"

    expected_metadata_name = f"{csv_file_name}.metadata.json"
    if metadata_file_name != expected_metadata_name:
        return (
            "metadata_file_name must exactly match the CSV base name as "
            f"'{expected_metadata_name}'"
        )

    return None


def _assert_s3_object_exists(bucket: str, key: str):
    s3_client.head_object(Bucket=bucket, Key=key)


def _start_ingestion(knowledge_base_id: str, data_source_id: str) -> dict:
    resp = bedrock_agent.start_ingestion_job(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
        description="Triggered by admin Add CSV upload",
    )
    return resp["ingestionJob"]


def _get_user_id_by_email(connection, email: str) -> str | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM users
            WHERE email = %s
            LIMIT 1
            """,
            (email,),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _upsert_file_data_source_row(
    connection,
    *,
    name: str,
    data_source_type: str,
    created_by_user_id: str,
    metadata: dict,
) -> str:
    s3_bucket = metadata["s3_bucket"]
    s3_key = metadata["s3_key"]

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE metadata->>'s3_bucket' = %s
              AND metadata->>'s3_key' = %s
            LIMIT 1
            """,
            (s3_bucket, s3_key),
        )
        existing = cursor.fetchone()

        if existing:
            data_source_row_id = str(existing[0])
            cursor.execute(
                """
                UPDATE data_sources
                SET
                    name = %s,
                    type = %s::data_source_type,
                    metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE id = %s::uuid
                """,
                (
                    name,
                    data_source_type,
                    json.dumps(metadata),
                    data_source_row_id,
                ),
            )
            return data_source_row_id

        cursor.execute(
            """
            INSERT INTO data_sources (
                name,
                type,
                created_by,
                metadata
            )
            VALUES (%s, %s::data_source_type, %s::uuid, %s::jsonb)
            RETURNING id
            """,
            (
                name,
                data_source_type,
                created_by_user_id,
                json.dumps(metadata),
            ),
        )
        inserted = cursor.fetchone()
        return str(inserted[0])


def _insert_ingestion_run_row(
    connection,
    *,
    data_source_row_id: str,
    bedrock_ingestion_job_id: str,
) -> str:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_runs (
                data_source_id,
                status,
                error_message,
                metadata
            )
            VALUES (%s::uuid, %s::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (
                data_source_row_id,
                "running",
                json.dumps({
                    "bedrock_ingestion_job_id": bedrock_ingestion_job_id
                }),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def _create_ingestion_polling_schedule(
    *,
    knowledge_base_id: str,
    bedrock_data_source_id: str,
    bedrock_ingestion_job_id: str,
    db_ingestion_run_id: str,
) -> str:
    schedule_name = f"kb-ingestion-{db_ingestion_run_id}"

    payload = {
        "task": "poll_ingestion_run",
        "knowledge_base_id": knowledge_base_id,
        "bedrock_data_source_id": bedrock_data_source_id,
        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
        "db_ingestion_run_id": db_ingestion_run_id,
        "schedule_name": schedule_name,
    }

    scheduler_client.create_schedule(
        Name=schedule_name,
        GroupName="default",
        ScheduleExpression="rate(30 minutes)",
        FlexibleTimeWindow={"Mode": "OFF"},
        State="ENABLED",
        Target={
            "Arn": SCHEDULER_TARGET_ARN,
            "RoleArn": SCHEDULER_ROLE_ARN,
            "Input": json.dumps(payload),
        },
        Description=f"Poll Bedrock ingestion job {bedrock_ingestion_job_id} for run {db_ingestion_run_id}",
    )

    return schedule_name


def _update_ingestion_run_schedule_name(connection, *, ingestion_run_row_id: str, schedule_name: str):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = %s::uuid
            """,
            (
                json.dumps({"scheduler_name": schedule_name}),
                ingestion_run_row_id,
            ),
        )


def add_csv(event, body, connection, kb_id):
    csv_file_name = body.get("csv_file_name")
    csv_s3_bucket = body.get("csv_s3_bucket")
    csv_s3_key = body.get("csv_s3_key")

    metadata_file_name = body.get("metadata_file_name")
    metadata_s3_bucket = body.get("metadata_s3_bucket")
    metadata_s3_key = body.get("metadata_s3_key")

    created_by = body.get("created_by")

    if not csv_file_name or not csv_s3_bucket or not csv_s3_key:
        return _response(event, 400, {"error": "Missing CSV file details"})

    if not metadata_file_name or not metadata_s3_bucket or not metadata_s3_key:
        return _response(event, 400, {"error": "Missing metadata JSON file details"})

    if not created_by:
        return _response(event, 400, {"error": "Missing admin who is trying to add this CSV to knowledge base"})

    pair_error = _validate_file_pair(csv_file_name, metadata_file_name)
    if pair_error:
        return _response(event, 400, {"error": pair_error})

    logger.info(
        "Received add csv request: csv=%s metadata=%s created_by=%s",
        csv_file_name,
        metadata_file_name,
        created_by,
    )

    try:
        try:
            _assert_s3_object_exists(csv_s3_bucket, csv_s3_key)
            _assert_s3_object_exists(metadata_s3_bucket, metadata_s3_key)
        except Exception as e:
            logger.error("Uploaded file not found in S3: %s", e, exc_info=True)
            return _response(event, 400, {"error": "One or both uploaded files do not exist in S3"})

        all_data_sources = _list_all_data_sources(kb_id)

        s3_data_sources = []
        for summary in all_data_sources:
            data_source = _get_data_source(kb_id, summary["dataSourceId"])
            if _is_s3_data_source(data_source):
                s3_data_sources.append(data_source)

        if not s3_data_sources:
            return _response(
                event,
                500,
                {"error": "No S3 data source found in the knowledge base."},
            )

        if len(s3_data_sources) > 1:
            return _response(
                event,
                409,
                {"error": "Multiple S3 data sources found. Expected exactly one allocated S3 data source."},
            )

        s3_data_source = s3_data_sources[0]
        ingestion_job = _start_ingestion(kb_id, s3_data_source["dataSourceId"])

        created_by_user_id = _get_user_id_by_email(connection, created_by)
        if not created_by_user_id:
            return _response(event, 400, {"error": "Admin user not found in database"})

        try:
            csv_metadata = {
                "bedrock_data_source_id": s3_data_source["dataSourceId"],
                "bedrock_data_source_name": s3_data_source["name"],
                "s3_bucket": csv_s3_bucket,
                "s3_key": csv_s3_key,
                "companion_file_name": metadata_file_name,
                "companion_s3_bucket": metadata_s3_bucket,
                "companion_s3_key": metadata_s3_key,
                "source": "bedrock_s3_data_source",
                "action": "added_csv_and_metadata_files",
            }

            json_metadata = {
                "bedrock_data_source_id": s3_data_source["dataSourceId"],
                "bedrock_data_source_name": s3_data_source["name"],
                "s3_bucket": metadata_s3_bucket,
                "s3_key": metadata_s3_key,
                "companion_file_name": csv_file_name,
                "companion_s3_bucket": csv_s3_bucket,
                "companion_s3_key": csv_s3_key,
                "source": "bedrock_s3_data_source",
                "action": "added_csv_and_metadata_files",
            }

            csv_data_source_row_id = _upsert_file_data_source_row(
                connection,
                name=csv_file_name,
                data_source_type="csv",
                created_by_user_id=created_by_user_id,
                metadata=csv_metadata,
            )

            json_data_source_row_id = _upsert_file_data_source_row(
                connection,
                name=metadata_file_name,
                data_source_type="json",
                created_by_user_id=created_by_user_id,
                metadata=json_metadata,
            )

            csv_ingestion_run_row_id = _insert_ingestion_run_row(
                connection,
                data_source_row_id=csv_data_source_row_id,
                bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
            )

            json_ingestion_run_row_id = _insert_ingestion_run_row(
                connection,
                data_source_row_id=json_data_source_row_id,
                bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
            )

            connection.commit()

            csv_schedule_name = _create_ingestion_polling_schedule(
                knowledge_base_id=kb_id,
                bedrock_data_source_id=s3_data_source["dataSourceId"],
                bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
                db_ingestion_run_id=csv_ingestion_run_row_id,
            )

            json_schedule_name = _create_ingestion_polling_schedule(
                knowledge_base_id=kb_id,
                bedrock_data_source_id=s3_data_source["dataSourceId"],
                bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
                db_ingestion_run_id=json_ingestion_run_row_id,
            )

            _update_ingestion_run_schedule_name(
                connection=connection,
                ingestion_run_row_id=csv_ingestion_run_row_id,
                schedule_name=csv_schedule_name,
            )

            _update_ingestion_run_schedule_name(
                connection=connection,
                ingestion_run_row_id=json_ingestion_run_row_id,
                schedule_name=json_schedule_name,
            )

            connection.commit()

        except Exception:
            connection.rollback()
            raise

        return _response(
            event,
            200,
            {
                "message": "CSV and metadata JSON registered successfully and ingestion started.",
                "action": "added_csv_and_metadata_files",
                "csv_file_name": csv_file_name,
                "metadata_file_name": metadata_file_name,
                "created_by": created_by,
                "data_source_id": s3_data_source["dataSourceId"],
                "data_source_name": s3_data_source["name"],
                "ingestion_job_id": ingestion_job["ingestionJobId"],
                "db_csv_data_source_id": csv_data_source_row_id,
                "db_json_data_source_id": json_data_source_row_id,
                "db_csv_ingestion_run_id": csv_ingestion_run_row_id,
                "db_json_ingestion_run_id": json_ingestion_run_row_id,
                "csv_schedule_name": csv_schedule_name,
                "json_schedule_name": json_schedule_name,
            },
        )

    except Exception as e:
        logger.error("Failed to add CSV files to Bedrock knowledge base: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to add CSV files to knowledge base"})