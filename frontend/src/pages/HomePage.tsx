import { useState, useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { ViewProvider } from "@/providers/ViewContext";
import { SidebarProvider } from "@/providers/SidebarContext";
import SideBar from "@/components/ChatInterface/SideBar";
import Footer from "@/components/Footer";
import type { ChatSession } from "@/providers/view";
import { useUser } from "@/providers/user";
import { Button } from "@/components/ui/button";
import { ProfileModal } from "@/components/ProfileModal";

const DEFAULT_WELCOME_MESSAGE =
  "Together we will try to find the right program for you. Click below to start a new conversation:";
const DEFAULT_DISCLAIMER = "AI can make mistakes. Check important info.";

export default function HomePage() {
  const { userId, email, metadata } = useUser();
  const navigate = useNavigate();

  const showProfileModal = userId && !email && metadata?.profile_prompt_skipped !== true;

  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(
    null
  );
  const [isLoadingChatSessions, setIsLoadingChatSessions] = useState(true);
  const [welcomeMessage, setWelcomeMessage] = useState<string>(
    DEFAULT_WELCOME_MESSAGE
  );
  const [isLoadingWelcome, setIsLoadingWelcome] = useState(true);
  const [disclaimer, setDisclaimer] = useState<string>(DEFAULT_DISCLAIMER);
  const [isLoadingDisclaimer, setIsLoadingDisclaimer] = useState(true);

  const fetchSystemMessage = async (
    messageType: string,
    fallback: string,
    setter: (val: string) => void
  ) => {
    try {
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      if (!tokenResponse.ok) throw new Error("Failed to get public token");
      const { token } = await tokenResponse.json();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/system_message/${messageType}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) throw new Error(`Failed to fetch ${messageType}`);

      const data: { message?: string } = await response.json();
      setter(data.message?.trim() || fallback);
    } catch (err) {
      console.error(`Error fetching ${messageType}:`, err);
      setter(fallback);
    }
  };

  // Fetch chat sessions for the user
  const fetchChatSessions = async () => {
    if (!userId) {
      setIsLoadingChatSessions(false);
      return;
    }

    setIsLoadingChatSessions(true);
    try {
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      if (!tokenResponse.ok) throw new Error("Failed to get public token");
      const { token } = await tokenResponse.json();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/user/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch chat sessions");
      }

      const sessions: ChatSession[] = await response.json();
      setChatSessions(sessions || []);
    } catch (err) {
      console.error("Error fetching chat sessions:", err);
    } finally {
      setIsLoadingChatSessions(false);
    }
  };

  useEffect(() => {
    setIsLoadingWelcome(true);
    setIsLoadingDisclaimer(true);

    Promise.all([
      fetchSystemMessage("welcome_message", DEFAULT_WELCOME_MESSAGE, setWelcomeMessage),
      fetchSystemMessage("disclaimer", DEFAULT_DISCLAIMER, setDisclaimer),
    ]).finally(() => {
      setIsLoadingWelcome(false);
      setIsLoadingDisclaimer(false);
    });
    fetchChatSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Create a new chat session
  const createNewChatSession = async (): Promise<ChatSession | null> => {
    if (!userId) return null;

    try {
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      if (!tokenResponse.ok) throw new Error("Failed to get public token");
      const { token } = await tokenResponse.json();

      const createResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user_sessions_session_id: userId,
          }),
        }
      );

      if (!createResponse.ok) {
        throw new Error("Failed to create chat session");
      }

      const newSession: ChatSession = await createResponse.json();

      // Add to the list and set as active
      setChatSessions((prev) => [newSession, ...prev]);
      setActiveChatSessionId(newSession.id);

      return newSession;
    } catch (err) {
      console.error("Error creating chat session:", err);
      return null;
    }
  };

  const refreshChatSessions = async () => {
    await fetchChatSessions();
  };

  // Update chat session name locally
  const updateChatSessionName = (sessionId: string, name: string) => {
    setChatSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, name } : session
      )
    );
  };

  // Welcome CTA action
  const handleStartNewConversation = async () => {
    const session = await createNewChatSession();
    if (session) {
      navigate("/chat");
    }
  };

  // Show loading screen while fetching initial data
  if (isLoadingChatSessions) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <div className="pt-[70px] flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ViewProvider
      value={{
        loading: false,
        error: null,
        chatSessions,
        activeChatSessionId,
        setActiveChatSessionId,
        isLoadingChatSessions,
        createNewChatSession,
        refreshChatSessions,
        updateChatSessionName,
      }}
    >
      <SidebarProvider>
        <div className="flex flex-col min-h-screen bg-background relative">
          {showProfileModal && (
            <ProfileModal onDismiss={() => {
              // The modal updates Context, but locally we just rely on Context changing
              // Because Context provider triggers re-render, it should vanish automatically.
            }} />
          )}
          <SideBar />
          <div className="md:ml-64 flex flex-col flex-1">
            <main className="flex-1 flex flex-col items-center justify-center max-w-screen px-4">
              {!activeChatSessionId ? (
                <div className="w-full max-w-2xl text-center">
                  <h1 className="text-3xl md:text-4xl font-bold mb-4 leading-tight">
                    Welcome to Specialization Explorer!
                  </h1>

                  <p className="text-base md:text-lg text-muted-foreground mb-8 whitespace-pre-line">
                    {isLoadingWelcome ? "Loading..." : welcomeMessage}
                  </p>

                  <Button
                    size="lg"
                    onClick={handleStartNewConversation}
                    className="px-8"
                    disabled={isLoadingWelcome}
                  >
                    Start a new conversation
                  </Button>

                  <p className="mt-4 text-xs text-muted-foreground">
                    {isLoadingDisclaimer ? "" : disclaimer}
                  </p>
                </div>
              ) : (
                <Outlet />
              )}
            </main>
            <Footer />
          </div>
        </div>
      </SidebarProvider>
    </ViewProvider>
  );
}
