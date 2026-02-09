import { BrowserRouter, Routes, Route } from "react-router";
import AIChatPage from "./pages/ChatInterface/ChatInterface";
import UserGuidelines from "./pages/UserGuidelines";
import { UserSessionProvider } from "./providers/UserSessionContext";
import { ModeProvider } from "@/providers/ModeContext";
import HomePage from "./pages/HomePage";
import AdminLogin from "./pages/Admin/AdminLogin";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import TextbookDetailsPage from "./pages/Admin/TextbookDetailsPage";
import ProtectedRoute from "./components/ProtectedRoute";
import { Amplify } from "aws-amplify";

Amplify.configure({
  API: {
    REST: {
      MyApi: {
        endpoint: import.meta.env.VITE_API_ENDPOINT,
      },
    },
  },
  Auth: {
    Cognito: {
      userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
    },
  },
});

// Pre-warm Lambdas on app load to reduce cold start latency
// Uses WebSocket to send a warmup action that triggers the practice material Lambda
async function warmupLambdas() {
  const apiEndpoint = import.meta.env.VITE_API_ENDPOINT;
  const wsUrl = import.meta.env.VITE_WEBSOCKET_URL;

  if (!apiEndpoint || !wsUrl) return;

  try {
    // Get authentication token
    const tokenResponse = await fetch(`${apiEndpoint}/user/publicToken`);
    if (!tokenResponse.ok) return;

    const { token } = await tokenResponse.json();
    if (!token) return;

    // Connect to WebSocket and send warmup action
    const ws = new WebSocket(`${wsUrl}?token=${token}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ action: "warmup" }));
      // Close connection after sending - we don't need to wait for response
      setTimeout(() => ws.close(), 1000);
    };

    ws.onerror = () => {
      // Ignore errors - warmup is best-effort
    };
  } catch {
    // Ignore errors - warmup is best-effort
  }
}

// Call warmup once when module loads
warmupLambdas();


function App() {
  return (
    <BrowserRouter>
      <UserSessionProvider>
        <ModeProvider>
          <Routes>
            <Route path="/" element={<HomePage />}>
              <Route path="chat" element={<AIChatPage />} />
            </Route>
            <Route path="/guidelines" element={<UserGuidelines />} />

            {/* Admin Routes */}
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route
              path="/admin/dashboard"
              element={
                <ProtectedRoute>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/textbook/:id"
              element={
                <ProtectedRoute>
                  <TextbookDetailsPage />
                </ProtectedRoute>
              }
            />
          </Routes>
        </ModeProvider>
      </UserSessionProvider>
    </BrowserRouter>
  );
}

export default App;
