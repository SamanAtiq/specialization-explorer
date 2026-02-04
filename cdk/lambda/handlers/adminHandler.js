/**
 * AWS Lambda Handler for Admin Operations
 *
 * This Lambda function handles HTTP requests for administrative operations including:
 * - Admin user management (create, read, update, delete)
 * - System administration tasks
 * - Content management operations
 *
 * This handler requires admin-level authentication via AWS Cognito.
 * Only authenticated admin users can access these endpoints.
 */

const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} = require("@aws-sdk/client-ssm");
const {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");

let sqlConnection;
const secretsManager = new SecretsManagerClient();
const ssmClient = new SSMClient();
const cloudwatchLogsClient = new CloudWatchLogsClient();

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const getSecretValueCommand = new GetSecretValueCommand({
        SecretId: process.env.SM_DB_CREDENTIALS,
      });
      const secretResponse = await secretsManager.send(getSecretValueCommand);
      const credentials = JSON.parse(secretResponse.SecretString);

      const connectionConfig = {
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: false },
      };

      sqlConnection = postgres(connectionConfig);
      await sqlConnection`SELECT 1`;
      console.log("Database connection initialized successfully");
    } catch (error) {
      console.error("Error initializing database connection:", error);
      throw error;
    }
  }
};

const createResponse = () => ({
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Headers":
      "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
  },
  body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.log(error);
  response.body = JSON.stringify(error.message);
};

/**
 * Main Lambda handler function
 * @param {Object} event - AWS Lambda event object containing HTTP request data
 * @returns {Object} HTTP response object with statusCode, headers, and body
 */
exports.handler = async (event) => {
  const response = createResponse();

  // Ensure database connection is ready
  await initConnection();
  await initConnection();

  let data; // Variable to store response data
  try {
    // Route requests based on HTTP method and URL path
    // event.httpMethod: GET, POST, PUT, DELETE
    // event.resource: URL pattern like /admin/users or /admin/exampleEndpoint
    const pathData = event.httpMethod + " " + event.resource;

    // Handle different API endpoints using switch statement
    switch (pathData) {
      // GET /admin/exampleEndpoint - Test endpoint for development and debugging
      case "GET /admin/exampleEndpoint":
        // Simple test response to verify Lambda function is working
        data = "Example endpoint invoked";
        response.body = JSON.stringify(data);
        break;

      // GET /admin/textbooks - Get all textbooks with user and question counts
      case "GET /admin/textbooks":
        const adminLimit = Math.min(
          parseInt(event.queryStringParameters?.limit) || 50,
          100
        );
        const adminOffset = parseInt(event.queryStringParameters?.offset) || 0;

        // Query to get textbooks with aggregated user and question counts
        const textbooksData = await sqlConnection`
          SELECT 
            t.id,
            t.title,
            t.authors,
            t.publisher,
            t.publish_date,
            t.summary,
            t.language,
            t.level,
            t.status,
            t.created_at,
            t.updated_at,
            COUNT(DISTINCT cs.user_session_id) as user_count,
            COUNT(DISTINCT ui.id) as question_count,
            COUNT(*) OVER() as total_count
          FROM textbooks t
          LEFT JOIN chat_sessions cs ON t.id = cs.textbook_id
          LEFT JOIN user_interactions ui ON cs.id = ui.chat_session_id
          GROUP BY t.id, t.title, t.authors, t.publisher, t.publish_date, t.summary, t.language, t.level, t.status, t.created_at, t.updated_at
          ORDER BY t.created_at DESC
          LIMIT ${adminLimit} OFFSET ${adminOffset}
        `;

        const adminTotal =
          textbooksData.length > 0 ? parseInt(textbooksData[0].total_count) : 0;

        // Format the response
        const formattedTextbooks = textbooksData.map((book) => ({
          id: book.id,
          title: book.title,
          authors: book.authors || [],
          publisher: book.publisher,
          publish_date: book.publish_date,
          summary: book.summary,
          language: book.language,
          level: book.level,
          status: book.status || "Disabled",
          created_at: book.created_at,
          updated_at: book.updated_at,
          user_count: parseInt(book.user_count) || 0,
          question_count: parseInt(book.question_count) || 0,
        }));

        response.statusCode = 200;
        response.body = JSON.stringify({
          textbooks: formattedTextbooks,
          pagination: {
            limit: adminLimit,
            offset: adminOffset,
            total: adminTotal,
            hasMore: adminOffset + adminLimit < adminTotal,
          },
        });
        break;

      // GET /admin/textbooks/{textbook_id} - Get single textbook with detailed information
      case "GET /admin/textbooks/{textbook_id}":
        const getTextbookId = event.pathParameters?.textbook_id;
        if (!getTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        // Query textbook with aggregated stats
        const textbookDetails = await sqlConnection`
          SELECT 
            t.id,
            t.title,
            t.authors,
            t.publisher,
            t.publish_date,
            t.summary,
            t.language,
            t.level,
            t.status,
            t.source_url,
            t.license,
            t.created_at,
            t.updated_at,
            t.metadata,
            COUNT(DISTINCT cs.user_session_id) as user_count,
            COUNT(DISTINCT ui.id) as question_count,
            COUNT(DISTINCT s.id) as section_count,
            COUNT(DISTINCT mi.id) FILTER (WHERE mi.media_type = 'image') as image_count,
            COUNT(DISTINCT mi.id) FILTER (WHERE mi.media_type = 'video') as video_count,
            COUNT(DISTINCT mi.id) FILTER (WHERE mi.media_type = 'audio') as audio_count
          FROM textbooks t
          LEFT JOIN chat_sessions cs ON t.id = cs.textbook_id
          LEFT JOIN user_interactions ui ON cs.id = ui.chat_session_id
          LEFT JOIN sections s ON t.id = s.textbook_id
          LEFT JOIN media_items mi ON t.id = mi.textbook_id
          WHERE t.id = ${getTextbookId}
          GROUP BY t.id
        `;

        if (textbookDetails.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Textbook not found" });
          break;
        }

        const textbook = textbookDetails[0];
        response.statusCode = 200;
        response.body = JSON.stringify({
          id: textbook.id,
          title: textbook.title,
          authors: textbook.authors || [],
          publisher: textbook.publisher,
          publish_date: textbook.publish_date,
          summary: textbook.summary,
          language: textbook.language,
          level: textbook.level,
          status: textbook.status || "Disabled",
          source_url: textbook.source_url,
          license: textbook.license,
          created_at: textbook.created_at,
          updated_at: textbook.updated_at,
          metadata: textbook.metadata || {},
          user_count: parseInt(textbook.user_count) || 0,
          question_count: parseInt(textbook.question_count) || 0,
          section_count: parseInt(textbook.section_count) || 0,
          image_count: parseInt(textbook.image_count) || 0,
          video_count: parseInt(textbook.video_count) || 0,
          audio_count: parseInt(textbook.audio_count) || 0,
        });
        break;

      // GET /admin/textbooks/{textbook_id}/media - Get all media items for a textbook
      case "GET /admin/textbooks/{textbook_id}/media":
        const mediaTextbookId = event.pathParameters?.textbook_id;
        if (!mediaTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        // Query media items for the textbook
        const mediaItems = await sqlConnection`
          SELECT 
            id,
            media_type as type,
            uri as url,
            description,
            page_start,
            page_end,
            mime_type,
            size_bytes,
            created_at
          FROM media_items
          WHERE textbook_id = ${mediaTextbookId}
          ORDER BY page_start ASC, created_at ASC
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({
          textbook_id: mediaTextbookId,
          media_items: mediaItems.map((item) => ({
            id: item.id,
            type: item.type,
            url: item.url,
            description: item.description,
            page_start: item.page_start,
            page_end: item.page_end,
            mime_type: item.mime_type,
            size_bytes: item.size_bytes,
            created_at: item.created_at,
          })),
          total: mediaItems.length,
        });
        break;

      // GET /admin/textbooks/{textbook_id}/sections - Get all sections for a textbook
      case "GET /admin/textbooks/{textbook_id}/sections":
        const sectionsTextbookId = event.pathParameters?.textbook_id;
        if (!sectionsTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        // Query sections for the textbook
        const sections = await sqlConnection`
          SELECT 
            id,
            parent_section_id,
            title,
            order_index as order,
            page_start,
            page_end,
            summary as content_preview,
            created_at
          FROM sections
          WHERE textbook_id = ${sectionsTextbookId}
          ORDER BY order_index ASC, created_at ASC
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({
          textbook_id: sectionsTextbookId,
          sections: sections.map((section) => ({
            id: section.id,
            parent_section_id: section.parent_section_id,
            title: section.title,
            order: section.order,
            page_start: section.page_start,
            page_end: section.page_end,
            content_preview: section.content_preview,
            created_at: section.created_at,
          })),
          total: sections.length,
        });
        break;

      // PUT /admin/textbooks/{textbook_id} - Update textbook (including status)
      case "PUT /admin/textbooks/{textbook_id}":
        const updateTextbookId = event.pathParameters?.textbook_id;
        if (!updateTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        let updateData;
        try {
          updateData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        // Build dynamic update query
        const allowedFields = [
          "title",
          "authors",
          "publisher",
          "publish_date",
          "summary",
          "language",
          "level",
          "status",
          "source_url",
          "license",
        ];
        const updates = [];
        const values = [];

        Object.keys(updateData).forEach((key) => {
          if (allowedFields.includes(key) && updateData[key] !== undefined) {
            updates.push(key);
            values.push(updateData[key]);
          }
        });

        if (updates.length === 0) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "No valid fields to update",
          });
          break;
        }

        // Construct the SET clause dynamically
        const setClause = updates
          .map((field, idx) => `${field} = $${idx + 1}`)
          .join(", ");
        values.push(updateTextbookId); // Add textbook_id as the last parameter

        const updateResult = await sqlConnection.unsafe(
          `UPDATE textbooks 
           SET ${setClause}, updated_at = NOW() 
           WHERE id = $${values.length} 
           RETURNING id, title, authors, publisher, publish_date, summary, language, level, status, source_url, license, created_at, updated_at`,
          values
        );

        if (updateResult.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Textbook not found" });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify(updateResult[0]);
        break;

      // DELETE /admin/textbooks/{textbook_id} - Delete textbook
      case "DELETE /admin/textbooks/{textbook_id}":
        const deleteTextbookId = event.pathParameters?.textbook_id;
        if (!deleteTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        // Delete associated LangChain collection (vector store)
        try {
          await sqlConnection`
            DELETE FROM langchain_pg_collection WHERE name = ${deleteTextbookId}
          `;
        } catch (error) {
          console.warn(
            "Error deleting langchain collection (might not exist):",
            error
          );
        }

        const deletedTextbook = await sqlConnection`
          DELETE FROM textbooks WHERE id = ${deleteTextbookId} RETURNING id
        `;

        if (deletedTextbook.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Textbook not found" });
          break;
        }

        response.statusCode = 204;
        response.body = "";
        break;

      // GET /admin/textbooks/{textbook_id}/jobs - Get ingestion jobs for a textbook
      case "GET /admin/textbooks/{textbook_id}/jobs":
        const jobsTextbookId = event.pathParameters?.textbook_id;
        if (!jobsTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        const jobs = await sqlConnection`
          SELECT 
            id,
            textbook_id,
            status,
            ingested_sections,
            total_sections,
            ingested_images,
            ingested_videos,
            error_message,
            started_at,
            completed_at,
            created_at,
            updated_at,
            metadata
          FROM jobs
          WHERE textbook_id = ${jobsTextbookId}
          ORDER BY created_at DESC
          LIMIT 10
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({ jobs });
        break;

      // GET /admin/textbooks/{textbook_id}/analytics - Get analytics for a specific textbook
      case "GET /admin/textbooks/{textbook_id}/analytics":
        const analyticsTextbookId = event.pathParameters?.textbook_id;
        if (!analyticsTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        const analyticsTimeRange =
          event.queryStringParameters?.timeRange || "3m";

        // Calculate date range based on timeRange parameter
        let analyticsDaysBack = 90; // default 3 months

        // Parse timeRange format (e.g., "30d", "6m", "1y")
        const timeRangeMatch = analyticsTimeRange.match(/^(\d+)([dmy])$/);
        if (timeRangeMatch) {
          const value = parseInt(timeRangeMatch[1], 10);
          const unit = timeRangeMatch[2];

          if (unit === "d") {
            analyticsDaysBack = value;
          } else if (unit === "m") {
            analyticsDaysBack = value * 30; // Approximate month as 30 days
          } else if (unit === "y") {
            analyticsDaysBack = value * 365;
          }
        }

        // Cap at 365 days and ensure at least 1 day
        analyticsDaysBack = Math.min(Math.max(1, analyticsDaysBack), 365);

        const analyticsStartDate = new Date();
        analyticsStartDate.setDate(
          analyticsStartDate.getDate() - analyticsDaysBack
        );

        // Get time series data for users and questions specific to this textbook
        const textbookTimeSeriesData = await sqlConnection`
          WITH date_series AS (
            SELECT generate_series(
              DATE_TRUNC('day', ${analyticsStartDate.toISOString()}::timestamp),
              DATE_TRUNC('day', NOW()),
              '1 day'::interval
            )::date AS date
          ),
          daily_users AS (
            SELECT 
              DATE_TRUNC('day', cs.created_at)::date AS date,
              COUNT(DISTINCT cs.user_session_id) AS count
            FROM chat_sessions cs
            WHERE cs.textbook_id = ${analyticsTextbookId}
              AND cs.created_at >= ${analyticsStartDate.toISOString()}
            GROUP BY DATE_TRUNC('day', cs.created_at)::date
          ),
          daily_questions AS (
            SELECT 
              DATE_TRUNC('day', ui.created_at)::date AS date,
              COUNT(ui.id) AS count
            FROM user_interactions ui
            JOIN chat_sessions cs ON ui.chat_session_id = cs.id
            WHERE cs.textbook_id = ${analyticsTextbookId}
              AND ui.created_at >= ${analyticsStartDate.toISOString()}
            GROUP BY DATE_TRUNC('day', ui.created_at)::date
          )
          SELECT 
            TO_CHAR(ds.date, 'Mon DD') AS date,
            COALESCE(du.count, 0)::int AS users,
            COALESCE(dq.count, 0)::int AS questions
          FROM date_series ds
          LEFT JOIN daily_users du ON ds.date = du.date
          LEFT JOIN daily_questions dq ON ds.date = dq.date
          ORDER BY ds.date ASC
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({
          timeSeries: textbookTimeSeriesData,
        });
        break;

      // GET /admin/textbooks/{textbook_id}/faqs - Get FAQs for a specific textbook
      case "GET /admin/textbooks/{textbook_id}/faqs":
        const faqTextbookId = event.pathParameters?.textbook_id;
        if (!faqTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        const faqLimit = Math.min(
          parseInt(event.queryStringParameters?.limit) || 50,
          100
        );
        const faqOffset = parseInt(event.queryStringParameters?.offset) || 0;

        const faqs = await sqlConnection`
          SELECT 
            id,
            question_text,
            answer_text,
            usage_count,
            last_used_at,
            cached_at,
            COUNT(*) OVER() as total_count
          FROM faq_cache
          WHERE textbook_id = ${faqTextbookId}
          ORDER BY usage_count DESC, last_used_at DESC
          LIMIT ${faqLimit} OFFSET ${faqOffset}
        `;

        const faqTotal = faqs.length > 0 ? parseInt(faqs[0].total_count) : 0;
        const faqList = faqs.map(({ total_count, ...faq }) => faq);

        response.statusCode = 200;
        response.body = JSON.stringify({
          faqs: faqList,
          pagination: {
            limit: faqLimit,
            offset: faqOffset,
            total: faqTotal,
            hasMore: faqOffset + faqLimit < faqTotal,
          },
        });
        break;

      // GET /admin/textbooks/{textbook_id}/shared_prompts - Get shared user prompts for a specific textbook
      case "GET /admin/textbooks/{textbook_id}/shared_prompts":
        const promptTextbookId = event.pathParameters?.textbook_id;
        if (!promptTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        const promptLimit = Math.min(
          parseInt(event.queryStringParameters?.limit) || 50,
          100
        );
        const promptOffset = parseInt(event.queryStringParameters?.offset) || 0;

        const sharedPrompts = await sqlConnection`
          SELECT 
            id,
            title,
            prompt_text,
            visibility,
            tags,
            role,
            reported,
            created_at,
            updated_at,
            COUNT(*) OVER() as total_count
          FROM shared_user_prompts
          WHERE textbook_id = ${promptTextbookId}
          ORDER BY created_at DESC
          LIMIT ${promptLimit} OFFSET ${promptOffset}
        `;

        const promptTotal =
          sharedPrompts.length > 0 ? parseInt(sharedPrompts[0].total_count) : 0;
        const promptList = sharedPrompts.map(
          ({ total_count, ...prompt }) => prompt
        );

        response.statusCode = 200;
        response.body = JSON.stringify({
          prompts: promptList,
          pagination: {
            limit: promptLimit,
            offset: promptOffset,
            total: promptTotal,
            hasMore: promptOffset + promptLimit < promptTotal,
          },
        });
        break;

      // GET /admin/analytics/practice - Get aggregated practice material analytics
      case "GET /admin/analytics/practice":
        // Get total count
        const totalPracticeAggResult = await sqlConnection`
          SELECT COUNT(*) as count 
          FROM practice_material_analytics
        `;
        const totalPracticeAgg = parseInt(totalPracticeAggResult[0].count) || 0;

        // Get count by type
        const typeBreakdownAgg = await sqlConnection`
          SELECT material_type, COUNT(*) as count
          FROM practice_material_analytics
          GROUP BY material_type
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({
          total_generated: totalPracticeAgg,
          by_type: typeBreakdownAgg,
        });
        break;

      // GET /admin/textbooks/{textbook_id}/practice_analytics - Get practice material analytics
      case "GET /admin/textbooks/{textbook_id}/practice_analytics":
        const practiceTextbookId = event.pathParameters?.textbook_id;
        if (!practiceTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        // Get total count
        const totalPracticeResult = await sqlConnection`
          SELECT COUNT(*) as count 
          FROM practice_material_analytics 
          WHERE textbook_id = ${practiceTextbookId}
        `;
        const totalPractice = parseInt(totalPracticeResult[0].count) || 0;

        // Get count by type
        const typeBreakdown = await sqlConnection`
          SELECT material_type, COUNT(*) as count
          FROM practice_material_analytics
          WHERE textbook_id = ${practiceTextbookId}
          GROUP BY material_type
        `;

        // Get count by difficulty
        const difficultyBreakdown = await sqlConnection`
          SELECT difficulty, COUNT(*) as count
          FROM practice_material_analytics
          WHERE textbook_id = ${practiceTextbookId}
          GROUP BY difficulty
        `;

        // Get recent generations
        const recentGenerations = await sqlConnection`
          SELECT 
            id,
            material_type,
            topic,
            num_items,
            difficulty,
            created_at
          FROM practice_material_analytics
          WHERE textbook_id = ${practiceTextbookId}
          ORDER BY created_at DESC
          LIMIT 20
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({
          total_generated: totalPractice,
          by_type: typeBreakdown,
          by_difficulty: difficultyBreakdown,
          recent_activity: recentGenerations,
        });
        break;

      // GET /admin/textbooks/{textbook_id}/ingestion_status - Get detailed ingestion status
      case "GET /admin/textbooks/{textbook_id}/ingestion_status":
        const statusTextbookId = event.pathParameters?.textbook_id;
        if (!statusTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        // Get the latest job for this textbook to get ingestion progress
        const latestJob = await sqlConnection`
          SELECT 
            id,
            status,
            ingested_sections,
            total_sections,
            ingested_images,
            error_message,
            started_at,
            completed_at,
            created_at
          FROM jobs 
          WHERE textbook_id = ${statusTextbookId}
          ORDER BY created_at DESC 
          LIMIT 1
        `;

        // Default values if no job exists yet
        let totalSections = 0;
        let ingestedSections = 0;
        let jobStatus = null;
        let jobError = null;

        if (latestJob.length > 0) {
          const job = latestJob[0];
          totalSections = parseInt(job.total_sections) || 0;
          ingestedSections = parseInt(job.ingested_sections) || 0;
          jobStatus = job.status;
          jobError = job.error_message;
        }

        // Get all media items from media_items table
        const mediaLimit = Math.min(
          parseInt(event.queryStringParameters?.limit) || 100,
          200
        );
        const mediaOffset = parseInt(event.queryStringParameters?.offset) || 0;

        const mediaResult = await sqlConnection`
          SELECT 
            mi.id,
            mi.media_type,
            mi.uri,
            mi.source_url,
            mi.description,
            s.title as chapter_title,
            s.order_index as chapter_number,
            COUNT(*) OVER() as total_count
          FROM media_items mi
          LEFT JOIN sections s ON mi.section_id = s.id
          WHERE mi.textbook_id = ${statusTextbookId}
          ORDER BY s.order_index, mi.media_type, mi.id
          LIMIT ${mediaLimit} OFFSET ${mediaOffset}
        `;

        const mediaTotal =
          mediaResult.length > 0 ? parseInt(mediaResult[0].total_count) : 0;

        // Count images specifically
        const imageCount = mediaResult.filter(
          (item) => item.media_type === "image"
        ).length;

        // Format all media items
        const mediaList = mediaResult.map((row) => ({
          id: row.id,
          media_type: row.media_type,
          url: row.uri,
          source_url: row.source_url,
          description: row.description,
          chapter_number: row.chapter_number,
          chapter_title: row.chapter_title,
        }));

        response.statusCode = 200;
        response.body = JSON.stringify({
          total_sections: totalSections,
          ingested_sections: ingestedSections,
          image_count: imageCount,
          media_items: mediaList,
          job_status: jobStatus,
          job_error: jobError,
          media_pagination: {
            limit: mediaLimit,
            offset: mediaOffset,
            total: mediaTotal,
            hasMore: mediaOffset + mediaLimit < mediaTotal,
          },
        });
        break;

      // POST /admin/textbooks/{textbook_id}/refresh - Trigger textbook re-ingestion
      case "POST /admin/textbooks/{textbook_id}/refresh":
        const refreshTextbookId = event.pathParameters?.textbook_id;
        if (!refreshTextbookId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Textbook ID is required" });
          break;
        }

        // Verify textbook exists
        const textbookToRefresh = await sqlConnection`
          SELECT id FROM textbooks WHERE id = ${refreshTextbookId}
        `;

        if (textbookToRefresh.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Textbook not found" });
          break;
        }

        // Create a new job for re-ingestion
        const newJob = await sqlConnection`
          INSERT INTO jobs (textbook_id, status, started_at)
          VALUES (${refreshTextbookId}, 'pending', NOW())
          RETURNING id, textbook_id, status, created_at
        `;

        // Update textbook status to 'Ingesting'
        await sqlConnection`
          UPDATE textbooks 
          SET status = 'Ingesting', updated_at = NOW()
          WHERE id = ${refreshTextbookId}
        `;

        response.statusCode = 201;
        response.body = JSON.stringify({
          message: "Refresh job created successfully",
          job: newJob[0],
        });
        break;

      // POST /admin/users - Create new admin user in the system
      case "POST /admin/users":
        // Parse JSON request body containing new user data
        let userData;
        try {
          userData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        // Extract user fields from request body
        const { display_name, email, institution_id } = userData;

        // Validate required fields
        if (!display_name || !email) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "display_name and email are required",
          });
          break;
        }

        // Insert new admin user into database
        // Using postgres library template literal syntax for better performance
        const result = await sqlConnection`
          INSERT INTO users (display_name, email, institution_id, role)
          VALUES (${display_name}, ${email}, ${institution_id || null}, 'admin')
          RETURNING id, display_name, email, role, institution_id, created_at
        `;

        response.statusCode = 201; // Created
        data = result[0];
        response.body = JSON.stringify(data);
        break;

      // GET /admin/prompt_templates - Get all prompt templates
      case "GET /admin/prompt_templates":
        const promptTemplates = await sqlConnection`
          SELECT 
            id,
            name,
            description,
            type,
            current_version_id,
            created_by,
            visibility,
            metadata,
            created_at,
            updated_at
          FROM prompt_templates
          WHERE type = 'RAG' 
          ORDER BY created_at DESC
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({ templates: promptTemplates });
        break;

      // GET /admin/prompt_templates/{template_id} - Get single prompt template
      case "GET /admin/prompt_templates/{template_id}":
        const getTemplateId = event.pathParameters?.template_id;
        if (!getTemplateId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Template ID is required" });
          break;
        }

        const templateDetails = await sqlConnection`
          SELECT 
            id,
            name,
            description,
            type,
            current_version_id,
            created_by,
            visibility,
            metadata,
            created_at,
            updated_at
          FROM prompt_templates
          WHERE id = ${getTemplateId}
        `;

        if (templateDetails.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Template not found" });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify(templateDetails[0]);
        break;

      // POST /admin/prompt_templates - Create new prompt template
      case "POST /admin/prompt_templates":
        let templateData;
        try {
          templateData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const { name, description, type, visibility, metadata } = templateData;

        // Validate required fields
        if (!name || !type) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "name and type are required",
          });
          break;
        }

        // Validate type enum
        const validTypes = [
          "RAG",
          "quiz_generation",
          "mcq_generation",
          "audio_generation",
        ];
        if (!validTypes.includes(type)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: `Invalid type. Must be one of: ${validTypes.join(", ")}`,
          });
          break;
        }

        // Validate visibility enum if provided
        const validVisibilities = ["private", "org", "public"];
        if (visibility && !validVisibilities.includes(visibility)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: `Invalid visibility. Must be one of: ${validVisibilities.join(
              ", "
            )}`,
          });
          break;
        }

        const newTemplate = await sqlConnection`
          INSERT INTO prompt_templates (name, description, type, visibility, metadata)
          VALUES (
            ${name},
            ${description || null},
            ${type},
            ${visibility || "private"},
            ${metadata ? JSON.stringify(metadata) : "{}"}
          )
          RETURNING id, name, description, type, visibility, metadata, created_at, updated_at
        `;

        response.statusCode = 201;
        response.body = JSON.stringify(newTemplate[0]);
        break;

      // PUT /admin/prompt_templates/{template_id} - Update prompt template
      case "PUT /admin/prompt_templates/{template_id}":
        const updateTemplateId = event.pathParameters?.template_id;
        if (!updateTemplateId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Template ID is required" });
          break;
        }

        let updateTemplateData;
        try {
          updateTemplateData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        // Build dynamic update query for templates
        const allowedTemplateFields = [
          "name",
          "description",
          "type",
          "visibility",
          "metadata",
          "current_version_id",
        ];
        const templateUpdates = [];
        const templateValues = [];

        Object.keys(updateTemplateData).forEach((key) => {
          if (
            allowedTemplateFields.includes(key) &&
            updateTemplateData[key] !== undefined
          ) {
            // Validate type if being updated
            if (key === "type") {
              const validTypes = [
                "RAG",
                "quiz_generation",
                "mcq_generation",
                "audio_generation",
              ];
              if (!validTypes.includes(updateTemplateData[key])) {
                response.statusCode = 400;
                response.body = JSON.stringify({
                  error: `Invalid type. Must be one of: ${validTypes.join(
                    ", "
                  )}`,
                });
                return;
              }
            }
            // Validate visibility if being updated
            if (key === "visibility") {
              const validVisibilities = ["private", "org", "public"];
              if (!validVisibilities.includes(updateTemplateData[key])) {
                response.statusCode = 400;
                response.body = JSON.stringify({
                  error: `Invalid visibility. Must be one of: ${validVisibilities.join(
                    ", "
                  )}`,
                });
                return;
              }
            }
            templateUpdates.push(key);
            // Stringify metadata if it's an object
            if (
              key === "metadata" &&
              typeof updateTemplateData[key] === "object"
            ) {
              templateValues.push(JSON.stringify(updateTemplateData[key]));
            } else {
              templateValues.push(updateTemplateData[key]);
            }
          }
        });

        if (templateUpdates.length === 0) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "No valid fields to update",
          });
          break;
        }

        // Construct the SET clause dynamically
        const templateSetClause = templateUpdates
          .map((field, idx) => `${field} = $${idx + 1}`)
          .join(", ");
        templateValues.push(updateTemplateId);

        const updateTemplateResult = await sqlConnection.unsafe(
          `UPDATE prompt_templates 
           SET ${templateSetClause}, updated_at = NOW() 
           WHERE id = $${templateValues.length} 
           RETURNING id, name, description, type, visibility, metadata, current_version_id, created_at, updated_at`,
          templateValues
        );

        if (updateTemplateResult.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Template not found" });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify(updateTemplateResult[0]);
        break;

      // DELETE /admin/prompt_templates/{template_id} - Delete prompt template
      case "DELETE /admin/prompt_templates/{template_id}":
        const deleteTemplateId = event.pathParameters?.template_id;
        if (!deleteTemplateId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Template ID is required" });
          break;
        }

        const deletedTemplate = await sqlConnection`
          DELETE FROM prompt_templates WHERE id = ${deleteTemplateId} RETURNING id
        `;

        if (deletedTemplate.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Template not found" });
          break;
        }

        response.statusCode = 204;
        response.body = "";
        break;

      // GET /admin/analytics - Get analytics data
      case "GET /admin/analytics":
        let startDate, endDate;

        // Support custom date ranges
        if (
          event.queryStringParameters?.startDate &&
          event.queryStringParameters?.endDate
        ) {
          // Use custom date range
          startDate = new Date(event.queryStringParameters.startDate);
          endDate = new Date(event.queryStringParameters.endDate);

          // Validate dates
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "Invalid date format. Use ISO 8601 format (YYYY-MM-DD)",
            });
            break;
          }

          if (endDate < startDate) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "End date must be after start date",
            });
            break;
          }

          // Validate max 1 year range
          const daysDiff = Math.ceil(
            (endDate - startDate) / (1000 * 60 * 60 * 24)
          );
          if (daysDiff > 365) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "Date range cannot exceed 1 year (365 days)",
            });
            break;
          }

          console.log(
            `Using custom date range: ${startDate.toISOString()} to ${endDate.toISOString()}`
          );
        } else {
          // Use preset timeRange
          const timeRange = event.queryStringParameters?.timeRange || "3m";
          let daysBack = 90; // default 3 months

          // Parse timeRange format (e.g., "30d", "6m", "1y")
          const timeRangeMatch = timeRange.match(/^(\d+)([dmy])$/);
          if (timeRangeMatch) {
            const value = parseInt(timeRangeMatch[1], 10);
            const unit = timeRangeMatch[2];

            if (unit === "d") {
              daysBack = value;
            } else if (unit === "m") {
              daysBack = value * 30;
            } else if (unit === "y") {
              daysBack = value * 365;
            }
          }

          // Cap at 365 days and ensure at least 1 day
          daysBack = Math.min(Math.max(1, daysBack), 365);

          endDate = new Date();
          startDate = new Date();
          startDate.setDate(startDate.getDate() - daysBack);

          console.log(
            `Using preset time range: ${timeRange} (${daysBack} days)`
          );
        }

        // Get time series data for users and questions
        const timeSeriesData = await sqlConnection`
          WITH date_series AS (
            SELECT generate_series(
              DATE_TRUNC('day', ${startDate.toISOString()}::timestamp),
              DATE_TRUNC('day', ${endDate.toISOString()}::timestamp),
              '1 day'::interval
            )::date AS date
          ),
          daily_users AS (
            SELECT 
              DATE_TRUNC('day', us.created_at)::date AS date,
              COUNT(DISTINCT us.id) AS count
            FROM user_sessions us
            WHERE us.created_at >= ${startDate.toISOString()}
            GROUP BY DATE_TRUNC('day', us.created_at)::date
          ),
          daily_questions AS (
            SELECT 
              DATE_TRUNC('day', ui.created_at)::date AS date,
              COUNT(ui.id) AS count
            FROM user_interactions ui
            WHERE ui.created_at >= ${startDate.toISOString()}
            GROUP BY DATE_TRUNC('day', ui.created_at)::date
          )
          SELECT 
            TO_CHAR(ds.date, 'Mon DD') AS date,
            COALESCE(du.count, 0) AS users,
            COALESCE(dq.count, 0) AS questions
          FROM date_series ds
          LEFT JOIN daily_users du ON ds.date = du.date
          LEFT JOIN daily_questions dq ON ds.date = dq.date
          ORDER BY ds.date ASC
        `;

        // Get chat sessions per textbook
        const chatSessionsByTextbook = await sqlConnection`
          SELECT 
            t.id,
            t.title,
            COUNT(DISTINCT cs.id) AS session_count
          FROM textbooks t
          LEFT JOIN chat_sessions cs ON t.id = cs.textbook_id
          WHERE t.status = 'Active'
          GROUP BY t.id, t.title
          ORDER BY session_count DESC
          LIMIT 10
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({
          timeSeries: timeSeriesData,
          chatSessionsByTextbook: chatSessionsByTextbook.map((row) => ({
            name: row.title,
            sessions: parseInt(row.session_count),
          })),
        });
        break;

      // GET /admin/settings/token-limit - Get daily token limit
      case "GET /admin/settings/token-limit":
        try {
          const getCommand = new GetParameterCommand({
            Name: process.env.DAILY_TOKEN_LIMIT,
          });
          const parameterResult = await ssmClient.send(getCommand);

          response.statusCode = 200;
          response.body = JSON.stringify({
            tokenLimit: parameterResult.Parameter.Value,
          });
        } catch (error) {
          console.error("Error getting token limit:", error);
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "Failed to get token limit",
          });
        }
        break;

      // PUT /admin/settings/token-limit - Update daily token limit
      case "PUT /admin/settings/token-limit":
        let tokenLimitData;
        try {
          tokenLimitData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const { tokenLimit } = tokenLimitData;

        if (tokenLimit === undefined || tokenLimit === null) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "tokenLimit is required" });
          break;
        }

        // Validate tokenLimit is either "NONE" or a positive number
        if (
          tokenLimit !== "NONE" &&
          (isNaN(tokenLimit) || parseInt(tokenLimit) < 0)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "tokenLimit must be 'NONE' or a positive number",
          });
          break;
        }

        try {
          const putCommand = new PutParameterCommand({
            Name: process.env.DAILY_TOKEN_LIMIT,
            Value: String(tokenLimit),
            Overwrite: true,
          });
          await ssmClient.send(putCommand);

          response.statusCode = 200;
          response.body = JSON.stringify({
            message: "Token limit updated successfully",
            tokenLimit: String(tokenLimit),
          });
        } catch (error) {
          console.error("Error updating token limit:", error);
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "Failed to update token limit",
          });
        }
        break;

      // GET /admin/settings/system-prompt - Get system prompt
      case "GET /admin/settings/system-prompt":
        try {
          const result = await sqlConnection`
            SELECT value FROM system_settings WHERE key = 'system_prompt'
          `;

          const systemPrompt = result.length > 0 ? result[0].value : "";

          response.statusCode = 200;
          response.body = JSON.stringify({
            systemPrompt: systemPrompt,
          });
        } catch (error) {
          console.error("Error getting system prompt:", error);
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "Failed to get system prompt",
          });
        }
        break;

      // PUT /admin/settings/system-prompt - Update system prompt
      case "PUT /admin/settings/system-prompt":
        let promptData;
        try {
          promptData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const { systemPrompt } = promptData;

        if (systemPrompt === undefined || systemPrompt === null) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "systemPrompt is required" });
          break;
        }

        try {
          await sqlConnection`
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('system_prompt', ${systemPrompt}, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          `;

          response.statusCode = 200;
          response.body = JSON.stringify({
            message: "System prompt updated successfully",
            systemPrompt: String(systemPrompt),
          });
        } catch (error) {
          console.error("Error updating system prompt:", error);
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "Failed to update system prompt",
          });
        }
        break;

      // GET /admin/settings/user-guidelines - Get user guidelines
      case "GET /admin/settings/user-guidelines":
        try {
          const guidelinesResult = await sqlConnection`
            SELECT value FROM system_settings WHERE key = 'user_guidelines'
          `;

          const userGuidelines =
            guidelinesResult.length > 0 ? guidelinesResult[0].value : "";

          response.statusCode = 200;
          response.body = JSON.stringify({
            userGuidelines: userGuidelines,
          });
        } catch (error) {
          console.error("Error getting user guidelines:", error);
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "Failed to get user guidelines",
          });
        }
        break;

      // PUT /admin/settings/user-guidelines - Update user guidelines
      case "PUT /admin/settings/user-guidelines":
        let guidelinesData;
        try {
          guidelinesData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const { userGuidelines } = guidelinesData;

        if (userGuidelines === undefined || userGuidelines === null) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "userGuidelines is required",
          });
          break;
        }

        try {
          await sqlConnection`
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('user_guidelines', ${userGuidelines}, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          `;

          response.statusCode = 200;
          response.body = JSON.stringify({
            message: "User guidelines updated successfully",
            userGuidelines: String(userGuidelines),
          });
        } catch (error) {
          console.error("Error updating user guidelines:", error);
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "Failed to update user guidelines",
          });
        }
        break;

      // GET /admin/reported-items - Get all reported FAQs and shared prompts
      case "GET /admin/reported-items":
        const reportedLimit = Math.min(
          parseInt(event.queryStringParameters?.limit) || 50,
          100
        );
        const reportedOffset =
          parseInt(event.queryStringParameters?.offset) || 0;

        // Get reported FAQs grouped by textbook
        const reportedFAQs = await sqlConnection`
          SELECT 
            f.id,
            f.textbook_id,
            f.question_text,
            f.answer_text,
            f.usage_count,
            f.last_used_at,
            f.cached_at,
            t.title as textbook_title,
            COUNT(*) OVER() as total_count
          FROM faq_cache f
          LEFT JOIN textbooks t ON f.textbook_id = t.id
          WHERE f.reported = true
          ORDER BY f.cached_at DESC
          LIMIT ${reportedLimit} OFFSET ${reportedOffset}
        `;

        const faqsTotal =
          reportedFAQs.length > 0 ? parseInt(reportedFAQs[0].total_count) : 0;
        const faqsList = reportedFAQs.map(({ total_count, ...faq }) => faq);

        // Get reported shared prompts grouped by textbook
        const reportedPrompts = await sqlConnection`
          SELECT 
            sp.id,
            sp.textbook_id,
            sp.title,
            sp.prompt_text,
            sp.visibility,
            sp.tags,
            sp.created_at,
            t.title as textbook_title,
            COUNT(*) OVER() as total_count
          FROM shared_user_prompts sp
          LEFT JOIN textbooks t ON sp.textbook_id = t.id
          WHERE sp.reported = true
          ORDER BY sp.created_at DESC
          LIMIT ${reportedLimit} OFFSET ${reportedOffset}
        `;

        const promptsTotal =
          reportedPrompts.length > 0
            ? parseInt(reportedPrompts[0].total_count)
            : 0;
        const promptsList = reportedPrompts.map(
          ({ total_count, ...prompt }) => prompt
        );

        response.statusCode = 200;
        response.body = JSON.stringify({
          reportedFAQs: faqsList,
          reportedPrompts: promptsList,
          pagination: {
            faqs: {
              limit: reportedLimit,
              offset: reportedOffset,
              total: faqsTotal,
              hasMore: reportedOffset + reportedLimit < faqsTotal,
            },
            prompts: {
              limit: reportedLimit,
              offset: reportedOffset,
              total: promptsTotal,
              hasMore: reportedOffset + reportedLimit < promptsTotal,
            },
          },
        });
        break;

      // PUT /admin/reported-items/faq/{faq_id}/dismiss - Dismiss a reported FAQ
      case "PUT /admin/reported-items/faq/{faq_id}/dismiss":
        const dismissFaqId = event.pathParameters?.faq_id;
        if (!dismissFaqId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "FAQ ID is required" });
          break;
        }

        const dismissedFaq = await sqlConnection`
          UPDATE faq_cache
          SET reported = false
          WHERE id = ${dismissFaqId}
          RETURNING id
        `;

        if (dismissedFaq.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "FAQ not found" });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify({ message: "FAQ report dismissed" });
        break;

      // DELETE /admin/reported-items/faq/{faq_id} - Delete a reported FAQ
      case "DELETE /admin/reported-items/faq/{faq_id}":
        const deleteFaqId = event.pathParameters?.faq_id;
        if (!deleteFaqId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "FAQ ID is required" });
          break;
        }

        const deletedFaq = await sqlConnection`
          DELETE FROM faq_cache
          WHERE id = ${deleteFaqId}
          RETURNING id
        `;

        if (deletedFaq.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "FAQ not found" });
          break;
        }

        response.statusCode = 204;
        response.body = "";
        break;

      // PUT /admin/reported-items/prompt/{prompt_id}/dismiss - Dismiss a reported prompt
      case "PUT /admin/reported-items/prompt/{prompt_id}/dismiss":
        const dismissPromptId = event.pathParameters?.prompt_id;
        if (!dismissPromptId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Prompt ID is required" });
          break;
        }

        const dismissedPrompt = await sqlConnection`
          UPDATE shared_user_prompts
          SET reported = false
          WHERE id = ${dismissPromptId}
          RETURNING id
        `;

        if (dismissedPrompt.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Prompt not found" });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify({ message: "Prompt report dismissed" });
        break;

      // DELETE /admin/reported-items/prompt/{prompt_id} - Delete a reported prompt
      case "DELETE /admin/reported-items/prompt/{prompt_id}":
        const deletePromptId = event.pathParameters?.prompt_id;
        if (!deletePromptId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Prompt ID is required" });
          break;
        }

        const deletedPrompt = await sqlConnection`
          DELETE FROM shared_user_prompts
          WHERE id = ${deletePromptId}
          RETURNING id
        `;

        if (deletedPrompt.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Prompt not found" });
          break;
        }

        response.statusCode = 204;
        response.body = "";
        break;

      // Handle unsupported routes
      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    // Handle specific PostgreSQL error codes
    if (error.code === "23505") {
      // Unique constraint violation (duplicate email)
      response.statusCode = 409; // Conflict
      response.body = JSON.stringify({ error: "Email already exists" });
    } else if (error.code === "23502") {
      // Not null constraint violation
      response.statusCode = 400; // Bad Request
      response.body = JSON.stringify({ error: "Required field is missing" });
    } else {
      // Generic server error for other exceptions
      handleError(error, response);
    }
  }

  // Log response for debugging (visible in AWS CloudWatch Logs)
  console.log(response);

  // Return HTTP response to API Gateway, which forwards it to the client
  return response;
};
