const postgres = require("postgres");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

let sqlConnection;
const secretsManager = new SecretsManagerClient();

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
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
  },
  body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
  response.body = JSON.stringify({ error: "Internal server error" });
};

exports.handler = async (event) => {
  const response = createResponse();
  let data;

  try {
    // Ensure connection is initialized before proceeding
    await initConnection();
    const pathData = event.httpMethod + " " + event.resource;

    switch (pathData) {
      case "GET /faq/{faq_id}":
        const faqId = event.pathParameters?.faq_id;
        if (!faqId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "FAQ ID is required" });
          break;
        }

        const faq = await sqlConnection`
          SELECT id, question_text, answer_text, usage_count, last_used_at, cached_at
          FROM faq_cache
          WHERE id = ${faqId}
        `;

        if (faq.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "FAQ entry not found" });
          break;
        }

        data = faq[0];
        response.body = JSON.stringify(data);
        break;

      case "PUT /faq/{faq_id}":
        const putFaqId = event.pathParameters?.faq_id;
        if (!putFaqId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "FAQ ID is required" });
          break;
        }

        const updateData = parseBody(event.body);
        const { question_text: updateQuestion, answer_text: updateAnswer } = updateData;

        // Build update object with only provided fields
        const updates = {};
        if (updateQuestion) {
          updates.question_text = updateQuestion;
          updates.normalized_question = updateQuestion.toLowerCase().trim();
        }
        if (updateAnswer) {
          updates.answer_text = updateAnswer;
        }

        if (Object.keys(updates).length === 0) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "No valid fields to update" });
          break;
        }

        const updatedFaq = await sqlConnection`
          UPDATE faq_cache 
          SET ${sqlConnection(updates, Object.keys(updates))}
          WHERE id = ${putFaqId}
          RETURNING id, question_text, answer_text, usage_count, last_used_at, cached_at
        `;

        if (updatedFaq.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "FAQ entry not found" });
          break;
        }

        data = updatedFaq[0];
        response.body = JSON.stringify(data);
        break;

      case "DELETE /faq/{faq_id}":
        const deleteFaqId = event.pathParameters?.faq_id;
        if (!deleteFaqId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "FAQ ID is required" });
          break;
        }

        const deleteResult = await sqlConnection`
          DELETE FROM faq_cache
          WHERE id = ${deleteFaqId}
        `;

        if (deleteResult.count === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "FAQ entry not found" });
          break;
        }

        response.statusCode = 204;
        response.body = '';
        break;

      case "POST /faq/{faq_id}/report":
        const reportFaqId = event.pathParameters?.faq_id;
        if (!reportFaqId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "FAQ ID is required" });
          break;
        }

        const reportData = parseBody(event.body);
        const { reason, comment } = reportData;

        // Validate reason if provided
        const validReasons = ['inaccurate', 'inappropriate', 'outdated', 'other'];
        if (reason && !validReasons.includes(reason)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid reason. Must be one of: inaccurate, inappropriate, outdated, other"
          });
          break;
        }

        // Check if FAQ exists
        const existingFaq = await sqlConnection`
          SELECT id FROM faq_cache WHERE id = ${reportFaqId}
        `;

        if (existingFaq.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "FAQ entry not found" });
          break;
        }

        // Update the FAQ to mark it as reported and store report details in metadata
        const reportMetadata = {
          reason: reason || 'other',
          comment: comment || '',
          reported_at: new Date().toISOString()
        };

        const reportedFaq = await sqlConnection`
          UPDATE faq_cache
          SET 
            reported = true,
            metadata = jsonb_set(
              COALESCE(metadata::jsonb, '{}'::jsonb),
              '{report}',
              ${JSON.stringify(reportMetadata)}::jsonb
            )
          WHERE id = ${reportFaqId}
          RETURNING id, question_text, reported, metadata
        `;

        data = {
          id: reportedFaq[0].id,
          faq_id: reportedFaq[0].id,
          reported_at: reportMetadata.reported_at,
          reason: reportMetadata.reason,
          message: "FAQ has been reported successfully"
        };

        response.statusCode = 200;
        response.body = JSON.stringify(data);
        break;

      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    handleError(error, response);
  }

  console.log(response);
  return response;
};