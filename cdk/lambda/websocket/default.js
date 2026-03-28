const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const lambda = new LambdaClient({});

exports.handler = async (event) => {
  console.log("WebSocket message received:", {
    connectionId: event.requestContext.connectionId,
    routeKey: event.requestContext.routeKey,
    body: event.body,
    timestamp: new Date().toISOString(),
  });

  try {
    const body = JSON.parse(event.body);
    const { action, query, chat_session_id, user_id, is_intro_message } = body;

    if (action === "generate_text") {
      // Invoke the text generation Lambda function
      const textGenPayload = {
        pathParameters: {
          id: chat_session_id,
        },
        body: JSON.stringify({
          query: query,
          user_id: user_id,
          is_intro_message: is_intro_message
        }),
        requestContext: {
          connectionId: event.requestContext.connectionId,
          domainName: event.requestContext.domainName,
          stage: event.requestContext.stage,
        },
      };

      console.log(
        "Invoking text generation function with payload:",
        textGenPayload
      );

      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.TEXT_GEN_FUNCTION_NAME,
          InvocationType: "Event", // Asynchronous invocation
          Payload: JSON.stringify(textGenPayload),
        })
      );

      console.log("Text generation function invoked successfully:", result);

      return { statusCode: 200 };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Unknown action" }),
    };
  } catch (error) {
    console.error("Error processing WebSocket message:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
