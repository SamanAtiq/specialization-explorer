const postgres = require("postgres");
const {
    SecretsManagerClient,
    GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const crypto = require("crypto");

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

exports.handler = async (event) => {
    const response = createResponse();
    let data;

    try {
        // Ensure connection is initialized before proceeding
        await initConnection();
        const pathData = event.httpMethod + " " + event.resource;

        switch (pathData) {
            case "GET /welcome_message": {
                // Fetch the active welcome message (latest version if multiple are mistakenly active)
                const rows = await sqlConnection`
                  SELECT id, type, content, version, is_active, created_at
                  FROM system_messages
                  WHERE type = 'welcome_message'
                  AND is_active = true
                  ORDER BY version DESC, created_at DESC
                  LIMIT 1
              `;
                if (!rows || rows.length === 0) {
                    response.statusCode = 404;
                    response.body = JSON.stringify({
                        error: "No active welcome message found",
                    });
                    break;
                }
                const msg = rows[0];
                response.statusCode = 200;
                response.body = JSON.stringify({
                    id: msg.id,
                    type: msg.type,
                    message: msg.content,
                    version: msg.version,
                    created_at: msg.created_at,
                });
                break;
            }

            default:
                throw new Error(`Unsupported route: "${pathData}"`);
        }
    } catch (error) {
        handleError(error, response);
    }

    console.log(response);
    return response;
};
