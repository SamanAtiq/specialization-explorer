import { useState, useEffect } from "react";
import { Outlet } from "react-router";
import { TextbookViewProvider } from "@/providers/TextbookViewContext";
import { SidebarProvider } from "@/providers/SidebarContext";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import SideBar from "@/components/ChatInterface/SideBar";
import type { ChatSession } from "@/providers/textbookView";
import { useUserSession } from "@/providers/usersession";
import HomePageHeader from "@/components/HomePageHeader";

export default function TextbookLayout() {
  const { userSessionId } = useUserSession();

  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(
    null
  );
  const [isLoadingChatSessions, setIsLoadingChatSessions] = useState(true);

  // Fetch chat sessions for the user
  const fetchChatSessions = async () => {
    if (!userSessionId) {
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
        `${import.meta.env.VITE_API_ENDPOINT
        }/chat_sessions/user/${userSessionId}`,
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
      console.log("Fetched chat sessions:", sessions);
      setChatSessions(sessions || []);

      // If no active session is set and we have sessions, set the most recent one
      if (!activeChatSessionId && sessions.length > 0) {
        setActiveChatSessionId(sessions[0].id);
      }
    } catch (err) {
      console.error("Error fetching chat sessions:", err);
    } finally {
      setIsLoadingChatSessions(false);
    }
  };

  useEffect(() => {
    fetchChatSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userSessionId]);

  // Create a new chat session
  const createNewChatSession = async (): Promise<ChatSession | null> => {
    if (!userSessionId) return null;

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
            user_sessions_session_id: userSessionId,
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

  // Show loading screen while fetching initial data
  if (isLoadingChatSessions) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <HomePageHeader />
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
    <TextbookViewProvider
      value={{
        textbook: null,
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
        <div className="flex flex-col min-h-screen bg-background">
          <Header />
          <div className="pt-[70px] flex flex-1">
            <SideBar />
            <div className="md:ml-64 flex flex-col flex-1">
              <main className="flex-1 flex flex-col items-center justify-center max-w-screen">
                <Outlet />
              </main>
              <Footer />
            </div>
          </div>
        </div>
      </SidebarProvider>
    </TextbookViewProvider>
  );
}
