import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Bot, User, MessageSquare, ChevronDown, ChevronRight, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/functions/authService";
import { cn } from "@/lib/utils";

// --- Types ---
type UserData = {
    id: string;
    email: string;
    display_name: string;
    role: string;
    last_seen_at?: string;
};

type ChatSession = {
    id: string;
    user_id: string;
    title: string;
    created_at: string;
    last_active_at: string;
};

type ChatMessage = {
    id: string;
    chat_session_id: string;
    sender: "user" | "AI" | "system";
    content: string;
    created_at: string;
    sources?: any[];
};

export default function ChatHistory() {
    const [users, setUsers] = useState<UserData[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(false);

    const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(new Set());
    const [userSessions, setUserSessions] = useState<Record<string, ChatSession[]>>({});
    const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});

    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loadingMessages, setLoadingMessages] = useState(false);

    // Initial load
    useEffect(() => {
        fetchUsers();
    }, []);

    const getAuthHeaders = async () => {
        const session = await AuthService.getAuthSession(true);
        return {
            Authorization: session.tokens.idToken,
            "Content-Type": "application/json",
        };
    };

    const fetchUsers = async () => {
        try {
            setLoadingUsers(true);

            const cached = sessionStorage.getItem("adminChatUsers");
            if (cached) {
                setUsers(JSON.parse(cached));
                setLoadingUsers(false);
                return;
            }

            const headers = await getAuthHeaders();
            const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/users?limit=100`, { headers });
            if (!res.ok) throw new Error("Failed to fetch users");

            const data = await res.json();
            const usersData = data || [];

            sessionStorage.setItem("adminChatUsers", JSON.stringify(usersData));
            setUsers(usersData);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingUsers(false);
        }
    };

    const fetchSessionsForUser = async (userId: string) => {
        try {
            setLoadingSessions(prev => ({ ...prev, [userId]: true }));

            const cachedAll = sessionStorage.getItem("adminChatSessions");
            const sessionCache = cachedAll ? JSON.parse(cachedAll) : {};

            if (sessionCache[userId]) {
                setUserSessions(prev => ({ ...prev, [userId]: sessionCache[userId] }));
                setLoadingSessions(prev => ({ ...prev, [userId]: false }));
                return;
            }

            const headers = await getAuthHeaders();
            const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/users/${userId}/chat_sessions`, { headers });
            if (!res.ok) throw new Error("Failed to fetch sessions");

            const data = await res.json();
            const sessionsData = data || [];

            sessionCache[userId] = sessionsData;
            sessionStorage.setItem("adminChatSessions", JSON.stringify(sessionCache));

            setUserSessions(prev => ({ ...prev, [userId]: sessionsData }));
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingSessions(prev => ({ ...prev, [userId]: false }));
        }
    };

    const fetchMessagesForSession = async (sessionId: string) => {
        try {
            setLoadingMessages(true);

            const cachedAll = sessionStorage.getItem("adminChatMessages");
            const messagesCache = cachedAll ? JSON.parse(cachedAll) : {};

            if (messagesCache[sessionId]) {
                setMessages(messagesCache[sessionId]);
                setLoadingMessages(false);
                return;
            }

            const headers = await getAuthHeaders();
            const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/chat_sessions/${sessionId}/messages`, { headers });
            if (!res.ok) throw new Error("Failed to fetch messages");

            const data = await res.json();
            const messagesData = data || [];

            messagesCache[sessionId] = messagesData;
            sessionStorage.setItem("adminChatMessages", JSON.stringify(messagesCache));

            setMessages(messagesData);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingMessages(false);
        }
    };

    const toggleUserExpanded = (userId: string) => {
        setExpandedUserIds(prev => {
            const next = new Set(prev);
            if (next.has(userId)) {
                next.delete(userId);
            } else {
                next.add(userId);
                if (!userSessions[userId] && !loadingSessions[userId]) {
                    fetchSessionsForUser(userId);
                }
            }
            return next;
        });
    };

    const handleSessionSelect = (sessionId: string) => {
        setSelectedSessionId(sessionId);
        fetchMessagesForSession(sessionId);
    };

    const formatDate = (dateString?: string) => {
        if (!dateString) return "";
        return new Date(dateString).toLocaleString([], {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    };

    const handleRefresh = () => {
        sessionStorage.removeItem("adminChatUsers");
        sessionStorage.removeItem("adminChatSessions");
        sessionStorage.removeItem("adminChatMessages");

        setUsers([]);
        setUserSessions({});
        setExpandedUserIds(new Set());
        setSelectedSessionId(null);
        setMessages([]);

        fetchUsers();
    };

    return (
        <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500 flex flex-col h-[calc(100vh-8rem)]">
            <div className="flex-shrink-0 flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold text-gray-900">Chat History</h2>
                    <p className="text-gray-500 mt-1">
                        Review user conversations and chat sessions across the platform.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={handleRefresh} className="flex items-center gap-2">
                    <RefreshCw size={14} />
                    Refresh Data
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1 min-h-0">

                {/* Left Column: Users & Chat Sessions */}
                <Card className="md:col-span-1 border-gray-200 shadow-sm flex flex-col overflow-hidden h-full">
                    <CardHeader className="flex-shrink-0 border-b pb-4">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <User className="h-5 w-5 text-[#2c5f7c]" />
                            Users & Sessions
                        </CardTitle>
                        <CardDescription className="text-xs">
                            Select a user to view their chat sessions.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-0">
                        {loadingUsers ? (
                            <div className="text-center text-gray-500 py-10">Loading users...</div>
                        ) : users.length === 0 ? (
                            <div className="text-center text-gray-500 py-10">No users found.</div>
                        ) : (
                            <div className="p-3 space-y-2">
                                {users.map((user, index) => (
                                    <div key={user.id} className="w-full bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm transition-all hover:shadow-md">
                                        {/* User Header */}
                                        <button
                                            onClick={() => toggleUserExpanded(user.id)}
                                            className="w-full flex items-center justify-between p-5 hover:bg-gray-50 transition-colors text-left"
                                        >
                                            <div>
                                                <div className="font-semibold text-base text-gray-900">
                                                    {user.display_name || `User ${index + 1}`}
                                                </div>
                                                <div className="text-xs text-gray-500 font-mono truncate max-w-[180px]">
                                                    {user.email || 'No email provided'}
                                                </div>
                                            </div>
                                            <div className="text-gray-400">
                                                {expandedUserIds.has(user.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                            </div>
                                        </button>

                                        {/* Sessions List */}
                                        {expandedUserIds.has(user.id) && (
                                            <div className="bg-gray-50/70 border-t border-gray-100 p-3 space-y-2">
                                                {loadingSessions[user.id] ? (
                                                    <div className="text-xs text-center text-gray-500 py-2">Loading sessions...</div>
                                                ) : !userSessions[user.id] || userSessions[user.id].length === 0 ? (
                                                    <div className="text-xs text-center text-gray-400 py-2">No sessions found.</div>
                                                ) : (
                                                    userSessions[user.id].map((session, sessionIndex) => (
                                                        <button
                                                            key={session.id}
                                                            onClick={() => handleSessionSelect(session.id)}
                                                            className={cn(
                                                                "w-full text-left p-4 rounded-xl transition-all border",
                                                                selectedSessionId === session.id
                                                                    ? "bg-white border-[#2c5f7c] shadow-md ring-1 ring-[#2c5f7c]/20"
                                                                    : "bg-white border-gray-200 shadow-sm hover:border-[#2c5f7c]/50 hover:shadow-md"
                                                            )}
                                                        >
                                                            <div className="flex items-center gap-3 mb-1.5">
                                                                <MessageSquare size={16} className={selectedSessionId === session.id ? "text-[#2c5f7c]" : "text-gray-400"} />
                                                                <span className={cn(
                                                                    "text-sm font-semibold truncate",
                                                                    selectedSessionId === session.id ? "text-[#2c5f7c]" : "text-gray-700"
                                                                )}>
                                                                    {session.title || `Chat ${sessionIndex + 1}`}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center gap-1 text-[10px] text-gray-500 pl-5">
                                                                <Clock size={10} />
                                                                {formatDate(session.created_at)}
                                                            </div>
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Right Column: Conversation Viewer */}
                <Card className="md:col-span-2 border-gray-200 shadow-sm flex flex-col overflow-hidden h-full">
                    <CardHeader className="flex-shrink-0 border-b pb-4 bg-gray-50/50">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Bot className="h-5 w-5 text-[#2c5f7c]" />
                            Conversation
                        </CardTitle>
                        <CardDescription className="text-xs">
                            {selectedSessionId ? "Transcript of selected session." : "Select a session to view the transcript."}
                        </CardDescription>
                    </CardHeader>

                    <CardContent className="flex-1 overflow-y-auto p-6 md:p-8 bg-white relative">
                        {!selectedSessionId ? (
                            <div className="flex h-full flex-col items-center justify-center text-gray-400 gap-4">
                                <MessageSquare className="h-12 w-12 text-gray-200" />
                                <p className="text-lg">Select a chat session from the left to view the conversation here</p>
                            </div>
                        ) : loadingMessages ? (
                            <div className="flex h-full items-center justify-center">
                                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[#2c5f7c]" />
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-gray-400">
                                <p className="text-lg">This session has no messages yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                {messages.slice(1).map((msg, idx) => {
                                    const isUser = msg.sender.toLowerCase() === "user";
                                    return (
                                        <div
                                            key={msg.id || idx}
                                            className={cn("flex flex-col max-w-[85%]", isUser ? "ml-auto" : "mr-auto")}
                                        >
                                            <div className={cn(
                                                "flex items-center gap-2 mb-1 text-xs",
                                                isUser ? "justify-end text-gray-500" : "text-gray-500"
                                            )}>
                                                <span className="font-semibold">{isUser ? "User" : "Assistant"}</span>
                                                <span className="text-xs opacity-75">{formatDate(msg.created_at)}</span>
                                            </div>

                                            <div className={cn(
                                                "p-5 rounded-2xl shadow-sm text-[15px] whitespace-pre-wrap leading-relaxed",
                                                isUser
                                                    ? "bg-[#2c5f7c] text-white rounded-tr-sm"
                                                    : "bg-gray-50 border border-gray-200 text-gray-800 rounded-tl-sm shadow-md"
                                            )}>
                                                {msg.content}
                                            </div>

                                            {/* Display Sources (if AI and sources exist) */}
                                            {msg.sender === "AI" && msg.sources && (
                                                <div className="mt-2 pl-2 border-l-2 border-[#2c5f7c]/20 text-xs text-gray-500">
                                                    Sources attached
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}