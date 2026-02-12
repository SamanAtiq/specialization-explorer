import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams } from "react-router";
import AIChatMessage from "@/components/ChatInterface/AIChatMessage";
import UserChatMessage from "@/components/ChatInterface/UserChatMessage";
import { useTextbookView } from "@/providers/textbookView";
import { AiChatInput } from "@/components/ChatInterface/userInput";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { Message } from "@/types/Chat";
import { useUserSession } from "@/providers/usersession";

export default function AIChatPage() {
  // URL search params for pre-filled questions (from FAQ page)
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [initialMessageLoadTime, setInitialMessageLoadTime] = useState<
    number | null
  >(null);

  const {
    textbook,
    activeChatSessionId,
    chatSessions,
    createNewChatSession,
    isLoadingChatSessions,
    updateChatSessionName,
  } = useTextbookView();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null
  );

  const { sessionUuid } = useUserSession();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const textbookTitle = textbook?.title ?? "Calculus: Volume 3";

  // Auto-scroll to bottom when messages change or when typing starts
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Capture the initial messages load time to avoid autoplaying historical messages
  useEffect(() => {
    if (!isLoadingHistory && initialMessageLoadTime === null) {
      setInitialMessageLoadTime(Date.now());
    }
  }, [isLoadingHistory, initialMessageLoadTime]);

  // Initialize chat session if needed
  useEffect(() => {
    const initializeChatSession = async () => {
      // Wait for chat sessions to load
      if (isLoadingChatSessions) return;

      // If no active chat session and no existing sessions, create one
      if (!activeChatSessionId && chatSessions.length === 0) {
        console.log("No chat sessions found, creating new one");
        await createNewChatSession();
      }
    };

    initializeChatSession();
  }, [
    activeChatSessionId,
    chatSessions.length,
    isLoadingChatSessions,
    createNewChatSession,
  ]);

  const [webSocketToken, setWebSocketToken] = useState<string | null>(null);

  // WebSocket configuration
  const baseWebSocketUrl = useMemo(
    () => import.meta.env.VITE_WEBSOCKET_URL,
    []
  );
  const webSocketUrl = useMemo(() => {
    if (!baseWebSocketUrl || !webSocketToken) {
      return null;
    }

    try {
      const url = new URL(baseWebSocketUrl);
      url.searchParams.set("token", webSocketToken);
      return url.toString();
    } catch (error) {
      console.error("[WebSocket] Invalid base URL:", error);
      return null;
    }
  }, [baseWebSocketUrl, webSocketToken]);

  useEffect(() => {
    if (!baseWebSocketUrl) {
      console.warn("[WebSocket] Base URL not configured");
      return;
    }

    console.log("[WebSocket] Preparing connection", {
      url: baseWebSocketUrl,
      tokenAttached: Boolean(webSocketToken),
    });
  }, [baseWebSocketUrl, webSocketToken]);

  useEffect(() => {
    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT;
    if (!apiEndpoint) {
      console.warn(
        "[WebSocket] API endpoint not configured; skipping token fetch"
      );
      return;
    }

    let isActive = true;
    let refreshTimeoutId: number | undefined;
    const refreshDelayMs = 14 * 60 * 1000;
    const retryDelayMs = 30 * 1000;

    async function fetchToken() {
      if (!isActive) {
        return;
      }

      try {
        const response = await fetch(`${apiEndpoint}/user/publicToken`);
        if (!response.ok) {
          throw new Error(
            `Token request failed with status ${response.status}`
          );
        }

        const { token } = await response.json();
        if (!isActive) {
          return;
        }

        setWebSocketToken(token);
        scheduleNext(refreshDelayMs);
      } catch (error) {
        console.error("[WebSocket] Failed to fetch streaming token:", error);
        if (!isActive) {
          return;
        }

        setWebSocketToken(null);
        scheduleNext(retryDelayMs);
      }
    }

    function scheduleNext(delay: number) {
      if (!isActive) {
        return;
      }

      if (refreshTimeoutId !== undefined) {
        window.clearTimeout(refreshTimeoutId);
      }

      refreshTimeoutId = window.setTimeout(
        fetchToken,
        delay
      ) as unknown as number;
    }

    fetchToken();

    return () => {
      isActive = false;
      if (refreshTimeoutId !== undefined) {
        window.clearTimeout(refreshTimeoutId);
      }
    };
  }, []);

  // WebSocket message handlers - memoized to prevent unnecessary reconnections
  const handleWebSocketMessage = useCallback(
    (message: any) => {
      console.log("[WebSocket] Received message:", message);

      switch (message.type) {
        case "start":
          setIsStreaming(true);
          // Update the streaming message to show typing indicator
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId ? { ...msg, isTyping: true } : msg
              )
            );
          }
          break;

        case "chunk":
          if (message.content && streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                    ...msg,
                    text: msg.text + message.content,
                    isTyping: false,
                  }
                  : msg
              )
            );
          }
          break;

        case "complete":
          setIsStreaming(false);
          setStreamingMessageId(null);
          if (message.sources && streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? { ...msg, sources_used: message.sources, isTyping: false }
                  : msg
              )
            );
          }
          // Handle session name update
          if (message.session_name && activeChatSessionId) {
            updateChatSessionName(activeChatSessionId, message.session_name);
          }
          break;

        case "error":
          setIsStreaming(false);
          setStreamingMessageId(null);
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                    ...msg,
                    text: message.message || "An error occurred",
                    isTyping: false,
                  }
                  : msg
              )
            );
          }
          break;
      }
    },
    [streamingMessageId, activeChatSessionId, updateChatSessionName]
  ); // Only recreate when streamingMessageId changes

  const {
    sendMessage: sendWebSocketMessage,
    isConnected,
    connectionState,
    forceReconnect,
  } = useWebSocket(webSocketUrl, {
    onMessage: handleWebSocketMessage,
    onConnect: () => {
      console.log("[WebSocket] Connected", {
        url: baseWebSocketUrl,
        tokenAttached: Boolean(webSocketToken),
      });
      console.log("Streaming: ", isStreaming);
    },
    onDisconnect: () => {
      console.log("[WebSocket] Disconnected", {
        url: baseWebSocketUrl,
        tokenAttached: Boolean(webSocketToken),
      });
      console.log("Streaming: ", isStreaming);
    },
    onError: (error) => {
      console.error("[WebSocket] Error:", error, {
        url: baseWebSocketUrl,
        tokenAttached: Boolean(webSocketToken),
      });
      console.log("Streaming: ", isStreaming);
    },
  });

  // Load chat history and redirect if no chat session ID
  useEffect(() => {

    if (!activeChatSessionId) {
      return;
    }

    const loadChatHistory = async () => {
      setIsLoadingHistory(true);
      try {
        // Get public token
        const tokenResponse = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
        );
        if (!tokenResponse.ok) throw new Error("Failed to get public token");
        const { token } = await tokenResponse.json();

        const userId = sessionUuid;

        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/${userId}/chat_sessions/${activeChatSessionId}/chat_history`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) throw new Error("Failed to load chat history");

        interface ChatMessageRow {
          id: string;
          chat_session_id: string;
          sender: "user" | "AI";
          content: string;
          sources?: any; // jsonb
          created_at: string; // ISO
        }

        const data: { messages: ChatMessageRow[] } = await response.json();

        const chatMessages: Message[] = (data.messages || []).map((m) => ({
          id: m.id,
          sender: m.sender === "AI" ? ("bot" as const) : ("user" as const),
          text: m.content,
          sources_used: m.sender === "AI" ? (m.sources ? [m.sources] : []) : [],
          time: new Date(m.created_at).getTime(),
        }));

        // Ensure order (backend already orders, but safe)
        chatMessages.sort((a, b) => a.time - b.time);

        setMessages(chatMessages);
      } catch (error) {
        console.error("Failed to load chat history:", error);
      } finally {
        setIsLoadingHistory(false);
      }
    };

    loadChatHistory();
  }, [activeChatSessionId, sessionUuid]);

  async function sendMessage() {
    let text = message.trim();
    if (!text || !textbook) return;

    // Ensure we have an active chat session
    if (!activeChatSessionId) return;

    // Create user message for AI generation
    const userMsg: Message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "user",
      text,
      time: Date.now(),
    };

    // Create bot message placeholder for streaming
    const botMsg: Message = {
      id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "bot",
      text: "",
      sources_used: [],
      time: Date.now() + 1,
      isTyping: true, // Start with typing indicator
    };

    // Add user and bot messages
    setMessages((m) => [...m, userMsg, botMsg]);
    setStreamingMessageId(botMsg.id);
    setIsStreaming(true);

    // Try WebSocket streaming first, fallback to HTTP if not connected
    if (isConnected && webSocketUrl) {
      console.log("[WebSocket] Sending message via WebSocket:", {
        action: "generate_text",
        textbook_id: textbook.id,
        query: text,
        chat_session_id: activeChatSessionId,
      });
      const success = sendWebSocketMessage({
        action: "generate_text",
        textbook_id: textbook.id,
        query: text,
        chat_session_id: activeChatSessionId,
      });

      if (success) {
        console.log("[WebSocket] Message sent successfully.");
        return;
      } else {
        console.warn(
          "[WebSocket] Message send failed. Attempting reconnect..."
        );
        forceReconnect();
      }
    } else {
      console.warn(
        `[WebSocket] Not connected (state: ${connectionState}). Falling back to HTTP.`
      );
    }

    // Fallback to HTTP API if WebSocket is not available
    console.log("[WebSocket] Fallback: Sending message via HTTP API...");

    // Show typing indicator for HTTP fallback
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === botMsg.id ? { ...msg, isTyping: true } : msg
      )
    );

    try {
      // Get fresh token for the request
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      const { token } = await tokenResponse.json();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT
        }/chat_sessions/${activeChatSessionId}/text_generation`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            textbook_id: textbook.id,
            query: text,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to generate response");
      }

      const data = await response.json();

      // Update the bot message with the complete response
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsg.id
            ? {
              ...msg,
              text: data.response || "Sorry, I couldn't generate a response.",
              sources_used: data.sources || [],
              isTyping: false,
            }
            : msg
        )
      );

      // Handle session name update for HTTP fallback
      if (data.session_name && activeChatSessionId) {
        updateChatSessionName(activeChatSessionId, data.session_name);
      }
    } catch (error) {
      console.error("Error generating text:", error);
      // Update the bot message with error
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsg.id
            ? {
              ...msg,
              text: "Sorry, there was an error processing your request.",
              isTyping: false,
            }
            : msg
        )
      );
    } finally {
      setIsStreaming(false);
      setStreamingMessageId(null);
    }
  }

  // Handle pre-filled question from URL (e.g., from FAQ page)
  useEffect(() => {
    const question = searchParams.get("question");
    const answer = searchParams.get("answer");

    // Wait for history to finish loading before processing FAQ params
    if (
      question &&
      activeChatSessionId &&
      textbook &&
      !isStreaming &&
      !isLoadingHistory
    ) {
      // If both question and answer are provided (from FAQ), display them directly
      if (answer) {
        const userMsg: Message = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          sender: "user",
          text: question,
          time: Date.now(),
        };

        const botMsg: Message = {
          id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
          sender: "bot",
          text: answer,
          sources_used: [],
          time: Date.now() + 1,
        };

        // Append to existing messages (history)
        setMessages((prev) => [...prev, userMsg, botMsg]);
        setSearchParams({});
      } else {
        // Only question provided, send it to LLM
        setMessage(question);
        setSearchParams({});

        setTimeout(() => {
          if (question.trim()) {
            sendMessage();
          }
        }, 100);
      }
    }
  }, [
    searchParams,
    activeChatSessionId,
    textbook,
    isStreaming,
    isLoadingHistory,
  ]);

  function messageFormatter(message: Message) {
    if (message.sender === "user") {
      return (
        <UserChatMessage
          key={message.id}
          text={message.text}
          textbookId={textbook?.id || ""}
          messageTime={message.time}
          initialLoadTime={initialMessageLoadTime}
          id={message.id}
        />
      );
    } else {
      return (
        <AIChatMessage
          key={message.id}
          text={message.text}
          sources={message.sources_used}
          isTyping={message.isTyping}
          messageTime={message.time}
          initialLoadTime={initialMessageLoadTime}
          id={message.id}
        />
      );
    }
  }

  return (
    <div className="w-full max-w-2xl 2xl:max-w-3xl px-4 py-4">
      <div
        className={`flex flex-col w-full ${messages.length === 0
          ? "justify-center"
          : "justify-between min-h-[90vh]"
          }`}
      >
        <div
          className={`flex flex-col w-full max-w-2xl 2xl:max-w-3xl px-4 py-4 ${messages.length === 0
            ? "justify-center"
            : "justify-between min-h-[90vh]"
            }`}
        >
          {/* top section */}
          <div>
            {messages.length === 0 ? (
              <>
                {/* Hero title */}
                <h1 className="text-4xl font-bold text-center mb-4 leading-tight max-w-full break-words">
                  What can I help with?
                </h1>
              </>
            ) : (
              /* messages area */
              <div className="flex flex-col gap-4 mb-6">
                {isLoadingHistory ? (
                  <div className="flex items-center justify-center py-8">
                    <p className="text-muted-foreground">
                      Loading chat history...
                    </p>
                  </div>
                ) : (
                  <>
                    {messages.map((m) => messageFormatter(m))}
                    <div ref={messagesEndRef} />
                  </>
                )}
              </div>
            )}
          </div>

          {/* thebottom section */}
          <div>
            {/* Input Area */}
            <div className="relative mb-6">
              <AiChatInput
                value={message}
                onChange={(val: string) => setMessage(val)}
                placeholder={`Ask anything about ${textbookTitle}`}
                onSend={sendMessage}
              />
            </div>

            {/* AI Disclaimer */}
            <div className="mt-4 text-center">
              <p className="text-xs text-muted-foreground">
                AI can make mistakes. Check important info.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
