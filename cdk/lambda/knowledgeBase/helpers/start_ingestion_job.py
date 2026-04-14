import os
import json
import logging
import boto3
from uuid import uuid4

from helpers.cors import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]
SCHEDULER_ROLE_ARN = os.environ["SCHEDULER_ROLE_ARN"]
SCHEDULER_TARGET_ARN = os.environ["SCHEDULER_TARGET_ARN"]

MAX_TOTAL_DATA_SOURCES = 5
RESERVED_NON_WEB_DATA_SOURCES = 1
MAX_WEB_DATA_SOURCES = MAX_TOTAL_DATA_SOURCES - RESERVED_NON_WEB_DATA_SOURCES

WEBSITE_BATCH_SIZE = 5
NEAR_CAPACITY_THRESHOLD = 0.85
FULL_THRESHOLD = 0.95

SYNCING_STATUSES = {"STARTING", "IN_PROGRESS", "STOPPING"}
FAILED_STATUSES = {"FAILED"}
SUCCESS_STATUSES = {"COMPLETE"}

bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }


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


def _list_all_ingestion_jobs(knowledge_base_id: str, data_source_id: str) -> list[dict]:
    items = []
    next_token = None

    while True:
        kwargs = {
            "knowledgeBaseId": knowledge_base_id,
            "dataSourceId": data_source_id,
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        resp = bedrock_agent.list_ingestion_jobs(**kwargs)
        items.extend(resp.get("ingestionJobSummaries", []))
        next_token = resp.get("nextToken")

        if not next_token:
            break

    return items


def _sort_jobs_latest_first(jobs: list[dict]) -> list[dict]:
    return sorted(
        jobs,
        key=lambda j: j.get("updatedAt") or j.get("startedAt") or j.get("createdAt"),
        reverse=True,
    )


def _get_latest_ingestion_job(knowledge_base_id: str, data_source_id: str) -> dict | None:
    jobs = _list_all_ingestion_jobs(knowledge_base_id, data_source_id)
    if not jobs:
        return None
    return _sort_jobs_latest_first(jobs)[0]


def _is_web_data_source(data_source: dict) -> bool:
    return data_source.get("dataSourceConfiguration", {}).get("type") == "WEB"


def _is_s3_data_source(data_source: dict) -> bool:
    return data_source.get("dataSourceConfiguration", {}).get("type") == "S3"


def _get_seed_urls(data_source: dict) -> list[str]:
    seed_url_objs = (
        data_source.get("dataSourceConfiguration", {})
        .get("webConfiguration", {})
        .get("sourceConfiguration", {})
        .get("urlConfiguration", {})
        .get("seedUrls", [])
    )
    return [x.get("url") for x in seed_url_objs if x.get("url")]


def _get_max_pages(data_source: dict) -> int:
    return (
        data_source.get("dataSourceConfiguration", {})
        .get("webConfiguration", {})
        .get("crawlerConfiguration", {})
        .get("crawlerLimits", {})
        .get("maxPages", 25000)
    )


def _latest_failure_reasons(latest_job: dict | None) -> list[str]:
    if not latest_job:
        return []
    return latest_job.get("failureReasons", []) or []


def _looks_like_capacity_failure(failure_reasons: list[str]) -> bool:
    combined = " ".join(failure_reasons).lower()
    keywords = [
        "maxpages",
        "max pages",
        "25,000",
        "25000",
        "page limit",
        "crawl limit",
        "exceeded",
        "too many pages",
    ]
    return any(k in combined for k in keywords)


def _get_documents_scanned(latest_job: dict | None) -> int:
    if not latest_job:
        return 0
    stats = latest_job.get("statistics", {}) or {}
    return stats.get("numberOfDocumentsScanned", 0) or 0


def _classify_data_source(data_source: dict, latest_job: dict | None) -> dict:
    data_source_id = data_source["dataSourceId"]
    seed_urls = _get_seed_urls(data_source)
    max_pages = _get_max_pages(data_source)
    scanned = _get_documents_scanned(latest_job)
    status = latest_job.get("status") if latest_job else None
    failure_reasons = _latest_failure_reasons(latest_job)

    if status in SYNCING_STATUSES:
        state = "syncing"
    elif status in FAILED_STATUSES:
        state = "full" if _looks_like_capacity_failure(failure_reasons) else "error"
    elif status in SUCCESS_STATUSES:
        ratio = (scanned / max_pages) if max_pages else 0
        if ratio >= FULL_THRESHOLD:
            state = "full"
        elif ratio >= NEAR_CAPACITY_THRESHOLD:
            state = "near_capacity"
        else:
            state = "available"
    else:
        ratio = (scanned / max_pages) if max_pages else 0
        if ratio >= FULL_THRESHOLD:
            state = "full"
        elif ratio >= NEAR_CAPACITY_THRESHOLD:
            state = "near_capacity"
        else:
            state = "available"

    return {
        "data_source_id": data_source_id,
        "name": data_source.get("name"),
        "state": state,
        "seed_urls": seed_urls,
        "max_pages": max_pages,
        "documents_scanned": scanned,
        "headroom_ratio": 1 - ((scanned / max_pages) if max_pages else 0),
        "latest_ingestion_job": latest_job,
        "failure_reasons": failure_reasons,
        "data_source": data_source,
    }


def _select_best_available(classified: list[dict]) -> dict | None:
    candidates = [x for x in classified if x["state"] == "available"]
    if not candidates:
        return None
    return sorted(candidates, key=lambda x: x["headroom_ratio"], reverse=True)[0]


def _build_updated_web_config(
    data_source: dict,
    new_urls: list[str],
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> dict:
    config = data_source["dataSourceConfiguration"]
    web_config = config["webConfiguration"]
    crawler_config = web_config["crawlerConfiguration"]
    source_config = web_config["sourceConfiguration"]

    existing_seed_urls = source_config.get("urlConfiguration", {}).get("seedUrls", [])
    existing_urls = [x["url"] for x in existing_seed_urls if "url" in x]

    for url in new_urls:
        if url not in existing_urls:
            existing_seed_urls.append({"url": url})

    updated_crawler_config = dict(crawler_config)

    effective_includes = include_patterns if include_patterns else crawler_config.get("inclusionFilters")
    effective_excludes = exclude_patterns if exclude_patterns else crawler_config.get("exclusionFilters")

    if effective_includes:
        updated_crawler_config["inclusionFilters"] = effective_includes
    else:
        updated_crawler_config.pop("inclusionFilters", None)

    if effective_excludes:
        updated_crawler_config["exclusionFilters"] = effective_excludes
    else:
        updated_crawler_config.pop("exclusionFilters", None)

    user_agent_header = updated_crawler_config.get("userAgentHeader")
    if user_agent_header and len(user_agent_header) < 61:
        updated_crawler_config["userAgentHeader"] = (
            "Mozilla/5.0 (compatible; SpecExKnowledgeBaseCrawler/1.0; +https://example.com/bot)"
        )

    updated_source_config = {
        **source_config,
        "urlConfiguration": {"seedUrls": existing_seed_urls},
    }

    return {
        "type": "WEB",
        "webConfiguration": {
            "crawlerConfiguration": updated_crawler_config,
            "sourceConfiguration": updated_source_config,
        },
    }


def _update_existing_web_data_source(
    data_source: dict,
    knowledge_base_id: str,
    new_urls: list[str],
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> dict:
    updated_data_source_config = _build_updated_web_config(
        data_source=data_source,
        new_urls=new_urls,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )

    kwargs = {
        "knowledgeBaseId": knowledge_base_id,
        "dataSourceId": data_source["dataSourceId"],
        "name": data_source["name"],
        "dataSourceConfiguration": updated_data_source_config,
        "vectorIngestionConfiguration": data_source["vectorIngestionConfiguration"],
    }

    if data_source.get("description"):
        kwargs["description"] = data_source["description"]

    if data_source.get("dataDeletionPolicy"):
        kwargs["dataDeletionPolicy"] = data_source["dataDeletionPolicy"]

    if data_source.get("serverSideEncryptionConfiguration"):
        kwargs["serverSideEncryptionConfiguration"] = data_source["serverSideEncryptionConfiguration"]

    resp = bedrock_agent.update_data_source(**kwargs)
    return resp["dataSource"]


def _build_new_web_data_source_payload(
    template_data_source: dict,
    new_urls: list[str],
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> dict:
    template_config = template_data_source["dataSourceConfiguration"]
    template_web = template_config["webConfiguration"]
    template_crawler = template_web["crawlerConfiguration"]

    crawler_config = dict(template_crawler)

    effective_includes = include_patterns if include_patterns else template_crawler.get("inclusionFilters")
    effective_excludes = exclude_patterns if exclude_patterns else template_crawler.get("exclusionFilters")

    if effective_includes:
        crawler_config["inclusionFilters"] = effective_includes
    else:
        crawler_config.pop("inclusionFilters", None)

    if effective_excludes:
        crawler_config["exclusionFilters"] = effective_excludes
    else:
        crawler_config.pop("exclusionFilters", None)

    user_agent_header = crawler_config.get("userAgentHeader")
    if user_agent_header and len(user_agent_header) < 61:
        crawler_config["userAgentHeader"] = (
            "Mozilla/5.0 (compatible; SpecExKnowledgeBaseCrawler/1.0; +https://example.com/bot)"
        )

    return {
        "name": f"web-crawler-{uuid4().hex[:8]}",
        "dataSourceConfiguration": {
            "type": "WEB",
            "webConfiguration": {
                "crawlerConfiguration": crawler_config,
                "sourceConfiguration": {
                    "urlConfiguration": {
                        "seedUrls": [{"url": url} for url in new_urls]
                    }
                },
            },
        },
        "vectorIngestionConfiguration": template_data_source["vectorIngestionConfiguration"],
    }


def _create_new_web_data_source(
    template_data_source: dict,
    knowledge_base_id: str,
    new_urls: list[str],
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> dict:
    payload = _build_new_web_data_source_payload(
        template_data_source=template_data_source,
        new_urls=new_urls,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )

    resp = bedrock_agent.create_data_source(
        knowledgeBaseId=knowledge_base_id,
        name=payload["name"],
        dataSourceConfiguration=payload["dataSourceConfiguration"],
        vectorIngestionConfiguration=payload["vectorIngestionConfiguration"],
        description=f"Auto-created web crawler for {', '.join(new_urls[:2])}",
    )
    return resp["dataSource"]


def _start_bedrock_ingestion(knowledge_base_id: str, data_source_id: str, description: str) -> dict:
    resp = bedrock_agent.start_ingestion_job(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
        description=description,
    )
    return resp["ingestionJob"]


def _create_ingestion_polling_schedule(
    *,
    phase: str,
    knowledge_base_id: str,
    bedrock_data_source_id: str,
    bedrock_ingestion_job_id: str,
    db_ingestion_run_ids: list[str],
    sync_session_id: str,
    interval_minutes: int,
) -> str:
    schedule_name = f"kb-{phase}-{sync_session_id}-{uuid4().hex[:8]}"

    payload = {
        "task": "poll_ingestion_run",
        "phase": phase,
        "knowledge_base_id": knowledge_base_id,
        "bedrock_data_source_id": bedrock_data_source_id,
        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
        "db_ingestion_run_ids": db_ingestion_run_ids,
        "sync_session_id": sync_session_id,
        "schedule_name": schedule_name,
    }

    scheduler_client.create_schedule(
        Name=schedule_name,
        GroupName="default",
        ScheduleExpression=f"rate({interval_minutes} minutes)",
        FlexibleTimeWindow={"Mode": "OFF"},
        State="ENABLED",
        Target={
            "Arn": SCHEDULER_TARGET_ARN,
            "RoleArn": SCHEDULER_ROLE_ARN,
            "Input": json.dumps(payload),
        },
        Description=f"Poll Bedrock ingestion job {bedrock_ingestion_job_id} for sync session {sync_session_id}",
    )

    return schedule_name


def _latest_run_rows_by_status(connection, *, status: str, data_source_type: str | None = None) -> list[dict]:
    with connection.cursor() as cursor:
        query = """
            WITH latest_runs AS (
                SELECT
                    ir.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            SELECT
                lr.id,
                lr.data_source_id,
                lr.status,
                lr.metadata,
                ds.name,
                ds.type,
                ds.include_patterns,
                ds.exclude_patterns,
                ds.metadata AS data_source_metadata
            FROM latest_runs lr
            JOIN data_sources ds ON ds.id = lr.data_source_id
            WHERE lr.rn = 1
              AND lr.status = %s::ingestion_status
        """
        params = [status]

        if data_source_type:
            query += " AND ds.type = %s::data_source_type"
            params.append(data_source_type)

        query += " ORDER BY ds.created_at ASC, ds.id ASC"

        cursor.execute(query, params)
        rows = cursor.fetchall()

        results = []
        for row in rows:
            results.append(
                {
                    "ingestion_run_id": str(row[0]),
                    "data_source_id": str(row[1]),
                    "status": row[2],
                    "ingestion_metadata": row[3] or {},
                    "name": row[4],
                    "type": row[5],
                    "include_patterns": row[6] or [],
                    "exclude_patterns": row[7] or [],
                    "data_source_metadata": row[8] or {},
                }
            )
        return results


def _promote_pending_to_queued(connection, *, sync_session_id: str) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.id,
                    ir.data_source_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            UPDATE ingestion_runs ir
            SET
                status = 'queued'::ingestion_status,
                metadata = COALESCE(ir.metadata, '{}'::jsonb) || %s::jsonb
            FROM latest_runs lr
            WHERE ir.id = lr.id
              AND lr.rn = 1
              AND ir.status = 'pending'::ingestion_status
            """,
            (json.dumps({"sync_session_id": sync_session_id}),),
        )
        return cursor.rowcount


def _mark_runs_running(
    connection,
    *,
    ingestion_run_ids: list[str],
    bedrock_ingestion_job_id: str,
    phase: str,
    schedule_name: str,
    sync_session_id: str,
):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET
                status = 'running'::ingestion_status,
                metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = ANY(%s::uuid[])
            """,
            (
                json.dumps(
                    {
                        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
                        "phase": phase,
                        "schedule_name": schedule_name,
                        "sync_session_id": sync_session_id,
                    }
                ),
                ingestion_run_ids,
            ),
        )


def _get_single_s3_data_source(knowledge_base_id: str) -> dict | None:
    all_data_sources = _list_all_data_sources(knowledge_base_id)

    s3_data_sources = []
    for summary in all_data_sources:
        data_source = _get_data_source(knowledge_base_id, summary["dataSourceId"])
        if _is_s3_data_source(data_source):
            s3_data_sources.append(data_source)

    if len(s3_data_sources) != 1:
        return None

    return s3_data_sources[0]


def _next_queued_s3_runs(connection) -> list[dict]:
    queued_csv = _latest_run_rows_by_status(connection, status="queued", data_source_type="csv")
    queued_json = _latest_run_rows_by_status(connection, status="queued", data_source_type="json")

    if not queued_csv and not queued_json:
        return []

    return queued_csv + queued_json


def _group_key_for_website_run(run: dict) -> str:
    return json.dumps(
        {
            "include_patterns": run["include_patterns"] or [],
            "exclude_patterns": run["exclude_patterns"] or [],
        },
        sort_keys=True,
    )


def _next_queued_website_batch(connection) -> list[dict]:
    queued_websites = _latest_run_rows_by_status(connection, status="queued", data_source_type="website")
    if not queued_websites:
        return []

    first = queued_websites[0]
    group_key = _group_key_for_website_run(first)

    batch = []
    for run in queued_websites:
        if _group_key_for_website_run(run) == group_key:
            batch.append(run)
        if len(batch) >= WEBSITE_BATCH_SIZE:
            break

    return batch


def _start_s3_phase(connection, *, knowledge_base_id: str, sync_session_id: str) -> dict:
    queued_runs = _next_queued_s3_runs(connection)
    if not queued_runs:
        return {"started": False}

    s3_data_source = _get_single_s3_data_source(knowledge_base_id)
    if not s3_data_source:
        raise ValueError("Expected exactly one S3 data source in the knowledge base.")

    ingestion_job = _start_bedrock_ingestion(
        knowledge_base_id,
        s3_data_source["dataSourceId"],
        description="Triggered by admin sync for staged S3 files",
    )

    ingestion_run_ids = [x["ingestion_run_id"] for x in queued_runs]

    schedule_name = _create_ingestion_polling_schedule(
        phase="s3",
        knowledge_base_id=knowledge_base_id,
        bedrock_data_source_id=s3_data_source["dataSourceId"],
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        db_ingestion_run_ids=ingestion_run_ids,
        sync_session_id=sync_session_id,
        interval_minutes=5,
    )

    _mark_runs_running(
        connection,
        ingestion_run_ids=ingestion_run_ids,
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        phase="s3",
        schedule_name=schedule_name,
        sync_session_id=sync_session_id,
    )
    connection.commit()

    return {
        "started": True,
        "phase": "s3",
        "queued_count": len(queued_runs),
        "bedrock_data_source_id": s3_data_source["dataSourceId"],
        "bedrock_data_source_name": s3_data_source["name"],
        "bedrock_ingestion_job_id": ingestion_job["ingestionJobId"],
        "schedule_name": schedule_name,
        "ingestion_run_ids": ingestion_run_ids,
    }


def _start_website_phase(connection, *, knowledge_base_id: str, sync_session_id: str) -> dict:
    batch = _next_queued_website_batch(connection)
    if not batch:
        return {"started": False}

    urls = [x["name"] for x in batch]
    include_patterns = batch[0]["include_patterns"] or []
    exclude_patterns = batch[0]["exclude_patterns"] or []
    ingestion_run_ids = [x["ingestion_run_id"] for x in batch]

    all_data_sources = _list_all_data_sources(knowledge_base_id)

    web_crawlers = []
    for summary in all_data_sources:
        data_source = _get_data_source(knowledge_base_id, summary["dataSourceId"])
        if _is_web_data_source(data_source):
            web_crawlers.append(data_source)

    if not web_crawlers:
        raise ValueError("No existing web crawler template found.")

    classified = []
    for data_source in web_crawlers:
        latest_job = _get_latest_ingestion_job(knowledge_base_id, data_source["dataSourceId"])
        classified.append(_classify_data_source(data_source, latest_job))

    selected = _select_best_available(classified)

    if selected:
        target_data_source = _update_existing_web_data_source(
            data_source=selected["data_source"],
            knowledge_base_id=knowledge_base_id,
            new_urls=urls,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
        )
        action = "updated_existing_web_data_source"
    else:
        web_count = len(web_crawlers)
        if web_count >= MAX_WEB_DATA_SOURCES:
            raise ValueError("No available web crawler capacity for queued websites.")

        template_data_source = web_crawlers[0]
        target_data_source = _create_new_web_data_source(
            template_data_source=template_data_source,
            knowledge_base_id=knowledge_base_id,
            new_urls=urls,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
        )
        action = "created_new_web_data_source"

    ingestion_job = _start_bedrock_ingestion(
        knowledge_base_id,
        target_data_source["dataSourceId"],
        description="Triggered by admin sync for staged website batch",
    )

    schedule_name = _create_ingestion_polling_schedule(
        phase="website",
        knowledge_base_id=knowledge_base_id,
        bedrock_data_source_id=target_data_source["dataSourceId"],
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        db_ingestion_run_ids=ingestion_run_ids,
        sync_session_id=sync_session_id,
        interval_minutes=30,
    )

    _mark_runs_running(
        connection,
        ingestion_run_ids=ingestion_run_ids,
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        phase="website",
        schedule_name=schedule_name,
        sync_session_id=sync_session_id,
    )
    connection.commit()

    return {
        "started": True,
        "phase": "website",
        "queued_count": len(batch),
        "action": action,
        "bedrock_data_source_id": target_data_source["dataSourceId"],
        "bedrock_data_source_name": target_data_source["name"],
        "bedrock_ingestion_job_id": ingestion_job["ingestionJobId"],
        "schedule_name": schedule_name,
        "ingestion_run_ids": ingestion_run_ids,
        "urls": urls,
    }


def start_ingestion_job(event, body, connection, kb_id):
    created_by = body.get("created_by")
    if not created_by:
        return _response(event, 400, {"error": "Missing created_by"})

    created_by_user_id = _get_user_id_by_email(connection, created_by)
    if not created_by_user_id:
        return _response(event, 400, {"error": "Admin user not found in database"})

    sync_session_id = uuid4().hex

    try:
        queued_count = _promote_pending_to_queued(connection, sync_session_id=sync_session_id)
        connection.commit()

        if queued_count == 0:
            return _response(
                event,
                409,
                {
                    "error": "No pending data sources found to queue.",
                    "sync_session_id": sync_session_id,
                },
            )

        s3_started = _start_s3_phase(connection, knowledge_base_id=kb_id, sync_session_id=sync_session_id)
        if s3_started["started"]:
            return _response(
                event,
                200,
                {
                    "message": "Pending data sources queued and S3 sync started.",
                    "action": "queued_and_started_s3_sync",
                    "sync_session_id": sync_session_id,
                    "queued_count": queued_count,
                    "phase_started": "s3",
                    "details": s3_started,
                },
            )

        website_started = _start_website_phase(connection, knowledge_base_id=kb_id, sync_session_id=sync_session_id)
        if website_started["started"]:
            return _response(
                event,
                200,
                {
                    "message": "Pending data sources queued and website sync started.",
                    "action": "queued_and_started_website_sync",
                    "sync_session_id": sync_session_id,
                    "queued_count": queued_count,
                    "phase_started": "website",
                    "details": website_started,
                },
            )

        return _response(
            event,
            409,
            {
                "error": "Pending data sources were queued, but no eligible batch could be started.",
                "sync_session_id": sync_session_id,
                "queued_count": queued_count,
            },
        )

    except Exception as e:
        connection.rollback()
        logger.error("Failed to start ingestion job orchestration: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to start ingestion job orchestration"})