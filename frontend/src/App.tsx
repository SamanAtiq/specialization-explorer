import { BrowserRouter, Routes, Route } from "react-router";
import AppLayout from "./layouts/AppLayout";
import AIChatPage from "./pages/ChatInterface/ChatInterface";
import UserGuidelines from "./pages/UserGuidelines";
import { UserProvider } from "./providers/UserContext";
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





function App() {
  return (
    <BrowserRouter>
      <UserProvider>
        <Routes>
          <Route element={<AppLayout />}>
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
          </Route>
        </Routes>
      </UserProvider>
    </BrowserRouter>
  );
}

export default App;
