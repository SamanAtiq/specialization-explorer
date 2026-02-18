import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import {
  BarChart3,
  MessageSquare,
  FileVideo,
  CheckCircle2,
  ArrowLeft,
  Users,
  HelpCircle,
  Share2,
  AlertTriangle,
  BookOpen,
  Loader2,
} from "lucide-react";
import Footer from "@/components/Footer";
import logoImage from "@/assets/specex-new-logo.png";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AuthService } from "@/functions/authService";
import MetricCard from "@/components/Admin/MetricCard";
import CloudWatchLogsViewer from "@/components/Admin/CloudWatchLogsViewer";

type TextbookDetails = {
  id: string;
  title: string;
  authors: string[];
  status: string;
  user_count: number;
  question_count: number;
  section_count: number;
  image_count: number;
  video_count: number;
  audio_count: number;
  source_url?: string;
};

type TimeSeriesData = {
  date: string;
  users: number;
  questions: number;
};

type TextbookAnalyticsData = {
  timeSeries: TimeSeriesData[];
};

type PracticeAnalyticsData = {
  total_generated: number;
  by_type: { material_type: string; count: number }[];
  by_difficulty: { difficulty: string; count: number }[];
  recent_activity: {
    id: string;
    material_type: string;
    topic: string;
    num_items: number;
    difficulty: string;
    created_at: string;
  }[];
};

type FAQ = {
  id: string;
  question_text: string;
  answer_text: string;
  usage_count: number;
  last_used_at: string;
  cached_at: string;
};

type SharedPrompt = {
  id: string;
  title: string;
  prompt_text: string;
  visibility: string;
  tags: string[];
  role: string;
  reported: boolean;
  created_at: string;
  updated_at: string;
};

type MediaItem = {
  id: string;
  media_type: string;
  url: string;
  source_url: string;
  description: string;
  chapter_number: number;
  chapter_title: string;
};

type IngestionStatus = {
  total_sections: number;
  ingested_sections: number;
  image_count: number;
  media_items: MediaItem[];
  job_status: string | null;
  job_error: string | null;
  media_pagination?: PaginationInfo;
};

type PaginationInfo = {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-gray-200 shadow-sm overflow-hidden">
      <CardHeader className="pb-2 border-b border-gray-50 bg-gray-50/50">
        <CardTitle className="text-base font-semibold text-gray-900">
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="p-6 h-[300px]">{children}</CardContent>
    </Card>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 p-3 rounded-lg shadow-xl text-sm">
        <p className="font-semibold text-gray-900 mb-2">{label}</p>
        {payload.map((entry: any, index: number) => (
          <div
            key={index}
            className="flex items-center gap-2 text-xs text-gray-600 mb-1"
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color || entry.fill }}
            />
            <span className="capitalize">{entry.name}:</span>
            <span className="font-bold text-gray-900">{entry.value}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

export default function TextbookDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeView, setActiveView] = useState<
    "analytics" | "faq" | "status" | "practice"
  >("analytics");
  const [textbook, setTextbook] = useState<TextbookDetails | null>(null);
  const [analyticsData, setAnalyticsData] = useState<TextbookAnalyticsData>({
    timeSeries: [],
  });
  const [practiceAnalytics, setPracticeAnalytics] =
    useState<PracticeAnalyticsData | null>(null);
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [sharedPrompts, setSharedPrompts] = useState<SharedPrompt[]>([]);
  const [ingestionStatus, setIngestionStatus] =
    useState<IngestionStatus | null>(null);
  const [timeRange, setTimeRange] = useState("90d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination states
  const [faqsPagination, setFaqsPagination] = useState<PaginationInfo | null>(
    null
  );
  const [promptsPagination, setPromptsPagination] =
    useState<PaginationInfo | null>(null);
  const [loadingMoreFAQs, setLoadingMoreFAQs] = useState(false);
  const [loadingMorePrompts, setLoadingMorePrompts] = useState(false);
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);

  useEffect(() => {
    if (id) {
      fetchTextbookDetails();
      fetchAnalytics();
    }
  }, [id, timeRange]);

  useEffect(() => {
    if (id && activeView === "faq") {
      fetchFAQs();
      fetchSharedPrompts();
    }
    if (id && activeView === "status") {
      fetchIngestionStatus();
    }
    if (id && activeView === "practice") {
      fetchPracticeAnalytics();
    }
  }, [id, activeView]);

  const fetchTextbookDetails = async () => {
    try {
      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/textbooks/${id}`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch textbook details");
      }

      const data = await response.json();
      setTextbook(data);
    } catch (err) {
      console.error("Error fetching textbook details:", err);
      setError("Failed to load textbook details");
    }
  };

  const fetchAnalytics = async () => {
    try {
      setLoading(true);
      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/admin/textbooks/${id}/analytics?timeRange=${timeRange}`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch analytics data");
      }

      const data = await response.json();
      setAnalyticsData(data);
    } catch (err) {
      console.error("Error fetching analytics:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchPracticeAnalytics = async () => {
    try {
      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/admin/textbooks/${id}/practice_analytics`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch practice analytics");
      }

      const data = await response.json();
      setPracticeAnalytics(data);
    } catch (err) {
      console.error("Error fetching practice analytics:", err);
    }
  };

  const fetchFAQs = async (offset = 0, append = false) => {
    try {
      if (append) {
        setLoadingMoreFAQs(true);
      }

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/admin/textbooks/${id}/faqs?limit=50&offset=${offset}`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch FAQs");
      }

      const data = await response.json();
      if (append) {
        setFaqs((prev) => [...prev, ...(data.faqs || [])]);
      } else {
        setFaqs(data.faqs || []);
      }
      setFaqsPagination(data.pagination || null);
    } catch (err) {
      console.error("Error fetching FAQs:", err);
    } finally {
      setLoadingMoreFAQs(false);
    }
  };

  const handleLoadMoreFAQs = () => {
    if (faqsPagination && faqsPagination.hasMore) {
      fetchFAQs(faqsPagination.offset + faqsPagination.limit, true);
    }
  };

  const fetchSharedPrompts = async (offset = 0, append = false) => {
    try {
      if (append) {
        setLoadingMorePrompts(true);
      }

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/admin/textbooks/${id}/shared_prompts?limit=50&offset=${offset}`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch shared prompts");
      }

      const data = await response.json();
      if (append) {
        setSharedPrompts((prev) => [...prev, ...(data.prompts || [])]);
      } else {
        setSharedPrompts(data.prompts || []);
      }
      setPromptsPagination(data.pagination || null);
    } catch (err) {
      console.error("Error fetching shared prompts:", err);
    } finally {
      setLoadingMorePrompts(false);
    }
  };

  const handleLoadMorePrompts = () => {
    if (promptsPagination && promptsPagination.hasMore) {
      fetchSharedPrompts(
        promptsPagination.offset + promptsPagination.limit,
        true
      );
    }
  };

  const fetchIngestionStatus = async (offset = 0, append = false) => {
    try {
      if (append) {
        setLoadingMoreMedia(true);
      }

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/admin/textbooks/${id}/ingestion_status?limit=100&offset=${offset}`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch ingestion status");
      }

      const data = await response.json();

      if (append && ingestionStatus) {
        setIngestionStatus({
          ...data,
          media_items: [
            ...ingestionStatus.media_items,
            ...(data.media_items || []),
          ],
        });
      } else {
        setIngestionStatus(data);
      }
    } catch (err) {
      console.error("Error fetching ingestion status:", err);
    } finally {
      setLoadingMoreMedia(false);
    }
  };

  const handleLoadMoreMedia = () => {
    if (ingestionStatus?.media_pagination?.hasMore) {
      fetchIngestionStatus(
        ingestionStatus.media_pagination.offset +
          ingestionStatus.media_pagination.limit,
        true
      );
    }
  };

  if (!textbook && loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#2c5f7c]"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-red-600">Error</h2>
          <p className="text-gray-600 mt-2">{error}</p>
          <Button
            variant="default"
            onClick={() => navigate("/admin/dashboard")}
            className="mt-4"
          >
            Return to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  if (!textbook) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-900">
            Textbook Not Found
          </h2>
          <Button
            variant="link"
            onClick={() => navigate("/admin/dashboard")}
            className="mt-4"
          >
            Return to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  // Calculate totals from time series for the selected period
  const totalUsersPeriod = analyticsData.timeSeries.reduce(
    (acc, curr) => acc + Number(curr.users),
    0
  );
  const totalQuestionsPeriod = analyticsData.timeSeries.reduce(
    (acc, curr) => acc + Number(curr.questions),
    0
  );

  const COLORS = ["#0088FE", "#00C49F", "#FFBB28", "#FF8042", "#8884d8"];

  const formatMaterialType = (type: string) => {
    const map: Record<string, string> = {
      short_answer: "Short Answer",
      flashcard: "Flashcards",
      mcq: "Multiple Choice",
    };
    return (
      map[type] ||
      type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-gradient-to-r from-[#2c5f7c] to-[#3d7a9a] text-white h-[70px] flex items-center px-6 shadow-md z-10 justify-between">
        <div className="flex items-center gap-2">
          <img src={logoImage} alt="Specialization Explorer AI Logo" className="h-6 w-auto" />
          <h1 className="text-xl font-semibold">Specialization Explorer AI Admin</h1>
        </div>
        <Button
          variant="ghost"
          className="text-white hover:bg-white/10"
          onClick={() => navigate("/admin/dashboard")}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Dashboard
        </Button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 flex flex-col hidden md:flex">
          <div className="p-6 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900 line-clamp-2">
              {textbook.title}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {textbook.authors?.join(", ") || "Unknown Author"}
            </p>
            <Badge
              variant={textbook.status === "Active" ? "default" : "secondary"}
              className={`mt-3 ${
                textbook.status === "Active"
                  ? "bg-green-100 text-green-700 hover:bg-green-100"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-100"
              }`}
            >
              {textbook.status}
            </Badge>
          </div>

          <nav className="p-4 space-y-1">
            <Button
              variant={activeView === "analytics" ? "secondary" : "ghost"}
              className={`w-full justify-start ${
                activeView === "analytics"
                  ? "bg-[#2c5f7c]/10 text-[#2c5f7c] font-medium"
                  : "text-gray-600"
              }`}
              onClick={() => setActiveView("analytics")}
            >
              <BarChart3 className="mr-2 h-4 w-4" />
              Analytics
            </Button>
            <Button
              variant={activeView === "practice" ? "secondary" : "ghost"}
              className={`w-full justify-start ${
                activeView === "practice"
                  ? "bg-[#2c5f7c]/10 text-[#2c5f7c] font-medium"
                  : "text-gray-600"
              }`}
              onClick={() => setActiveView("practice")}
            >
              <BookOpen className="mr-2 h-4 w-4" />
              Practice Analytics
            </Button>
            <Button
              variant={activeView === "faq" ? "secondary" : "ghost"}
              className={`w-full justify-start ${
                activeView === "faq"
                  ? "bg-[#2c5f7c]/10 text-[#2c5f7c] font-medium"
                  : "text-gray-600"
              }`}
              onClick={() => setActiveView("faq")}
            >
              <MessageSquare className="mr-2 h-4 w-4" />
              FAQ & User Prompts
            </Button>
            <Button
              variant={activeView === "status" ? "secondary" : "ghost"}
              className={`w-full justify-start ${
                activeView === "status"
                  ? "bg-[#2c5f7c]/10 text-[#2c5f7c] font-medium"
                  : "text-gray-600"
              }`}
              onClick={() => setActiveView("status")}
            >
              <FileVideo className="mr-2 h-4 w-4" />
              Textbook Status & Media
            </Button>
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8 bg-gray-50">
          <div className="max-w-6xl mx-auto animate-in fade-in duration-500">
            {activeView === "analytics" && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900">
                      Analytics Overview
                    </h2>
                    <p className="text-gray-500">
                      Usage statistics and engagement metrics.
                    </p>
                  </div>

                  <div className="flex items-center bg-white rounded-lg border border-gray-200 p-1 px-3 shadow-sm gap-2">
                    <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
                      Last
                    </span>
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      className="h-8 w-20 text-center"
                      defaultValue={90}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val) && val > 0) {
                          // Cap at 365, min 1
                          const days = Math.min(Math.max(1, val), 365);
                          setTimeRange(`${days}d`);
                        }
                      }}
                    />
                    <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
                      Days
                    </span>
                  </div>
                </div>

                {loading && !analyticsData.timeSeries.length ? (
                  <div className="flex items-center justify-center py-20">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#2c5f7c]"></div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <MetricCard
                        title="Active User Sessions"
                        value={totalUsersPeriod.toString()}
                        icon={<Users className="h-5 w-5 text-blue-600" />}
                        trend="in selected period"
                        tooltip="Number of  user sessions who have interacted with this textbook during the selected time range."
                      />
                      <MetricCard
                        title="Questions Asked"
                        value={totalQuestionsPeriod.toString()}
                        icon={
                          <MessageSquare className="h-5 w-5 text-purple-600" />
                        }
                        trend="in selected period"
                        tooltip="Total number of questions asked by users about this textbook during the selected time range."
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-6">
                      <ChartCard
                        title="User Engagement"
                        subtitle="Active users interacting with this textbook"
                      >
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart
                            data={analyticsData.timeSeries}
                            margin={{
                              top: 10,
                              right: 10,
                              left: -20,
                              bottom: 0,
                            }}
                          >
                            <CartesianGrid
                              strokeDasharray="3 3"
                              vertical={false}
                              stroke="#e5e7eb"
                            />
                            <XAxis
                              dataKey="date"
                              axisLine={false}
                              tickLine={false}
                              tick={{ fontSize: 12, fill: "#6b7280" }}
                              dy={10}
                            />
                            <YAxis
                              axisLine={false}
                              tickLine={false}
                              tick={{ fontSize: 12, fill: "#6b7280" }}
                            />
                            <Tooltip content={<CustomTooltip />} />
                            <Line
                              type="monotone"
                              dataKey="users"
                              stroke="#2c5f7c"
                              strokeWidth={3}
                              dot={false}
                              activeDot={{ r: 6, strokeWidth: 0 }}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </ChartCard>

                      <ChartCard
                        title="Question Volume"
                        subtitle="Questions asked about this textbook"
                      >
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart
                            data={analyticsData.timeSeries}
                            margin={{
                              top: 10,
                              right: 10,
                              left: -20,
                              bottom: 0,
                            }}
                          >
                            <CartesianGrid
                              strokeDasharray="3 3"
                              vertical={false}
                              stroke="#e5e7eb"
                            />
                            <XAxis
                              dataKey="date"
                              axisLine={false}
                              tickLine={false}
                              tick={{ fontSize: 12, fill: "#6b7280" }}
                              dy={10}
                            />
                            <YAxis
                              axisLine={false}
                              tickLine={false}
                              tick={{ fontSize: 12, fill: "#6b7280" }}
                            />
                            <Tooltip content={<CustomTooltip />} />
                            <Line
                              type="monotone"
                              dataKey="questions"
                              stroke="#3d7a9a"
                              strokeWidth={3}
                              dot={false}
                              activeDot={{ r: 6, strokeWidth: 0 }}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </ChartCard>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeView === "practice" && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">
                    Practice Material Analytics
                  </h2>
                  <p className="text-gray-500">
                    Insights into practice material generation and usage.
                  </p>
                </div>

                {!practiceAnalytics ? (
                  <div className="flex items-center justify-center py-20">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#2c5f7c]"></div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <MetricCard
                        title="Total Generated"
                        value={practiceAnalytics.total_generated.toString()}
                        icon={<BookOpen className="h-5 w-5 text-blue-600" />}
                        trend="Total practice sets"
                        tooltip="Total number of practice material sets generated for this textbook."
                      />
                      <MetricCard
                        title="Most Popular Type"
                        value={
                          practiceAnalytics.by_type.sort(
                            (a, b) => b.count - a.count
                          )[0]
                            ? formatMaterialType(
                                practiceAnalytics.by_type.sort(
                                  (a, b) => b.count - a.count
                                )[0].material_type
                              )
                            : "N/A"
                        }
                        icon={
                          <CheckCircle2 className="h-5 w-5 text-green-600" />
                        }
                        trend="By volume"
                        tooltip="The type of practice material (e.g., Flashcards, MCQ) that has been generated the most."
                      />
                      <MetricCard
                        title="Most Popular Difficulty"
                        value={
                          practiceAnalytics.by_difficulty.sort(
                            (a, b) => b.count - a.count
                          )[0]?.difficulty || "N/A"
                        }
                        icon={
                          <AlertTriangle className="h-5 w-5 text-orange-600" />
                        }
                        trend="By volume"
                        tooltip="The difficulty level that has been selected most frequently for practice materials."
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <ChartCard
                        title="Generation by Type"
                        subtitle="Distribution of practice material types"
                      >
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={practiceAnalytics.by_type}>
                            <CartesianGrid
                              strokeDasharray="3 3"
                              vertical={false}
                            />
                            <XAxis
                              dataKey="material_type"
                              tickFormatter={formatMaterialType}
                            />
                            <YAxis />
                            <Tooltip
                              content={<CustomTooltip />}
                              labelFormatter={formatMaterialType}
                            />
                            <Bar dataKey="count" fill="#2c5f7c">
                              {practiceAnalytics.by_type.map((__, index) => (
                                <Cell
                                  key={`cell-${index}`}
                                  fill={COLORS[index % COLORS.length]}
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </ChartCard>

                      <ChartCard
                        title="Generation by Difficulty"
                        subtitle="Distribution of difficulty levels"
                      >
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={practiceAnalytics.by_difficulty}>
                            <CartesianGrid
                              strokeDasharray="3 3"
                              vertical={false}
                            />
                            <XAxis dataKey="difficulty" />
                            <YAxis />
                            <Tooltip content={<CustomTooltip />} />
                            <Bar dataKey="count" fill="#82ca9d">
                              {practiceAnalytics.by_difficulty.map(
                                (__, index) => (
                                  <Cell
                                    key={`cell-${index}`}
                                    fill={COLORS[index % COLORS.length]}
                                  />
                                )
                              )}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </ChartCard>
                    </div>

                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold text-gray-900">
                        Recent Activity
                      </h3>
                      <div className="grid gap-4">
                        {practiceAnalytics.recent_activity.map((activity) => (
                          <Card key={activity.id}>
                            <CardContent className="p-4 flex items-center justify-between">
                              <div>
                                <p className="font-medium text-gray-900">
                                  {activity.topic || "Untitled Topic"}
                                </p>
                                <div className="flex gap-2 mt-1">
                                  <Badge variant="outline" className="text-xs">
                                    {formatMaterialType(activity.material_type)}
                                  </Badge>
                                  <Badge
                                    variant="secondary"
                                    className="text-xs"
                                  >
                                    {activity.difficulty}
                                  </Badge>
                                  <span className="text-xs text-gray-500 flex items-center">
                                    {activity.num_items} items
                                  </span>
                                </div>
                              </div>
                              <div className="text-sm text-gray-500">
                                {new Date(
                                  activity.created_at
                                ).toLocaleDateString()}
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeView === "faq" && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">
                    FAQ & User Prompts
                  </h2>
                  <p className="text-gray-500">
                    Review frequently asked questions and shared user prompts.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* FAQs Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 mb-2">
                      <HelpCircle className="h-5 w-5 text-[#2c5f7c]" />
                      <h3 className="text-lg font-semibold text-gray-900">
                        Frequently Asked Questions
                      </h3>
                    </div>
                    {faqs.length === 0 ? (
                      <Card className="bg-gray-50 border-dashed">
                        <CardContent className="p-6 text-center text-gray-500">
                          No FAQs found for this textbook.
                        </CardContent>
                      </Card>
                    ) : (
                      faqs.map((faq) => (
                        <Card
                          key={faq.id}
                          className="hover:shadow-md transition-shadow"
                        >
                          <CardContent className="p-5">
                            <p className="font-medium text-gray-900 mb-2">
                              "{faq.question_text}"
                            </p>
                            <p className="text-sm text-gray-600 line-clamp-3 mb-3">
                              {faq.answer_text}
                            </p>
                            <div className="flex items-center justify-between text-xs text-gray-500">
                              <Badge variant="secondary" className="text-xs">
                                Used {faq.usage_count} times
                              </Badge>
                              <span>
                                Last used:{" "}
                                {new Date(
                                  faq.last_used_at
                                ).toLocaleDateString()}
                              </span>
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    )}

                    {/* Pagination Controls for FAQs */}
                    {faqsPagination && faqs.length > 0 && (
                      <div className="mt-4 flex flex-col items-center gap-3">
                        <p className="text-sm text-muted-foreground">
                          Showing {faqs.length} of {faqsPagination.total} FAQs
                        </p>
                        {faqsPagination.hasMore && (
                          <Button
                            onClick={handleLoadMoreFAQs}
                            disabled={loadingMoreFAQs}
                            variant="outline"
                            size="sm"
                            className="w-full max-w-xs"
                          >
                            {loadingMoreFAQs ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Loading...
                              </>
                            ) : (
                              "Load More FAQs"
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Shared Prompts Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Share2 className="h-5 w-5 text-[#2c5f7c]" />
                      <h3 className="text-lg font-semibold text-gray-900">
                        Shared User Prompts
                      </h3>
                    </div>
                    {sharedPrompts.length === 0 ? (
                      <Card className="bg-gray-50 border-dashed">
                        <CardContent className="p-6 text-center text-gray-500">
                          No shared prompts found for this textbook.
                        </CardContent>
                      </Card>
                    ) : (
                      sharedPrompts.map((prompt) => (
                        <Card
                          key={prompt.id}
                          className="hover:shadow-md transition-shadow"
                        >
                          <CardContent className="p-5">
                            <div className="flex justify-between items-start mb-2">
                              <h4 className="font-semibold text-gray-900">
                                {prompt.title || "Untitled Prompt"}
                              </h4>
                              {prompt.reported && (
                                <Badge
                                  variant="destructive"
                                  className="flex items-center gap-1 text-[10px] h-5"
                                >
                                  <AlertTriangle className="h-3 w-3" />
                                  Reported
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-gray-600 line-clamp-3 mb-3 italic">
                              "{prompt.prompt_text}"
                            </p>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {prompt.tags?.map((tag, i) => (
                                <Badge
                                  key={i}
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                            <div className="flex items-center justify-between text-xs text-gray-500 border-t pt-3 mt-2">
                              <span className="capitalize">
                                Role: {prompt.role || "User"}
                              </span>
                              <span>
                                {new Date(
                                  prompt.created_at
                                ).toLocaleDateString()}
                              </span>
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    )}

                    {/* Pagination Controls for Prompts */}
                    {promptsPagination && sharedPrompts.length > 0 && (
                      <div className="mt-4 flex flex-col items-center gap-3">
                        <p className="text-sm text-muted-foreground">
                          Showing {sharedPrompts.length} of{" "}
                          {promptsPagination.total} prompts
                        </p>
                        {promptsPagination.hasMore && (
                          <Button
                            onClick={handleLoadMorePrompts}
                            disabled={loadingMorePrompts}
                            variant="outline"
                            size="sm"
                            className="w-full max-w-xs"
                          >
                            {loadingMorePrompts ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Loading...
                              </>
                            ) : (
                              "Load More Prompts"
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeView === "status" && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">
                    Textbook Status & Media
                  </h2>
                  <p className="text-gray-500">
                    Ingestion status and linked materials.
                  </p>
                  {ingestionStatus?.job_status && (
                    <div className="mt-3">
                      <Badge
                        variant={
                          ingestionStatus.job_status === "done"
                            ? "default"
                            : ingestionStatus.job_status === "failed"
                            ? "destructive"
                            : "secondary"
                        }
                        className={
                          ingestionStatus.job_status === "done"
                            ? "bg-green-100 text-green-700"
                            : ingestionStatus.job_status === "running"
                            ? "bg-blue-100 text-blue-700"
                            : ""
                        }
                      >
                        {ingestionStatus.job_status.toUpperCase()}
                      </Badge>
                      {ingestionStatus.job_error && (
                        <p className="text-sm text-red-600 mt-2">
                          Error: {ingestionStatus.job_error}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div onClick={() => textbook?.source_url && window.open(textbook.source_url, "_blank")} className={textbook?.source_url ? "cursor-pointer" : ""}>
                    <MetricCard
                      title="Sections Ingested"
                      value={`${ingestionStatus?.ingested_sections || 0}/${
                        ingestionStatus?.total_sections || 0
                      }`}
                      icon={<CheckCircle2 className="h-5 w-5 text-green-600" />}
                      trend={
                        ingestionStatus?.ingested_sections ===
                          ingestionStatus?.total_sections &&
                        (ingestionStatus?.total_sections || 0) > 0
                          ? "Fully Ingested"
                          : "In Progress"
                      }
                      tooltip="Number of sections successfully processed and indexed out of the total sections found in the textbook. Click to view textbook source."
                    />
                  </div>
                  <div 
                    onClick={() => {
                      const mediaSection = document.getElementById('associated-media-section');
                      mediaSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className="cursor-pointer"
                  >
                    <MetricCard
                      title="Images Ingested"
                      value={(ingestionStatus?.image_count || 0).toString()}
                      icon={<FileVideo className="h-5 w-5 text-blue-600" />}
                      trend="Total images found"
                      tooltip="Total number of images extracted from the textbook content and indexed. Click to view associated media."
                    />
                  </div>
                </div>
                {/* CloudWatch Logs Viewer */}
                {id && <CloudWatchLogsViewer textbookId={id} />}
                <div id="associated-media-section">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    Associated Media (
                    {ingestionStatus?.media_items?.length || 0} items)
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {ingestionStatus?.media_items &&
                    ingestionStatus.media_items.length > 0 ? (
                      ingestionStatus.media_items.map(
                        (item: MediaItem, i: number) => (
                          <Card key={item.id}>
                            <CardContent className="p-4 flex items-center justify-between">
                              <div className="flex items-center gap-4">
                                <div className="h-12 w-12 rounded-lg bg-blue-100 flex items-center justify-center overflow-hidden shrink-0">
                                  {item.media_type === "image" && item.url ? (
                                    <img
                                      src={item.url}
                                      alt={item.description || "Media"}
                                      className="h-full w-full object-cover"
                                      onError={(e) => {
                                        e.currentTarget.style.display = "none";
                                      }}
                                    />
                                  ) : (
                                    <FileVideo className="h-6 w-6 text-blue-600" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <p className="font-medium text-gray-900 line-clamp-1">
                                      {item.description ||
                                        `${item.media_type} ${i + 1}`}
                                    </p>
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] shrink-0"
                                    >
                                      {item.media_type}
                                    </Badge>
                                  </div>
                                  <p className="text-sm text-gray-500 truncate">
                                    Chapter {item.chapter_number}:{" "}
                                    {item.chapter_title || "Unknown"}
                                  </p>
                                </div>
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => window.open(item.url, "_blank")}
                                disabled={!item.url}
                              >
                                View
                              </Button>
                            </CardContent>
                          </Card>
                        )
                      )
                    ) : (
                      <div className="text-center py-10 text-gray-500 bg-gray-50 rounded-lg border border-dashed">
                        No media items found for this textbook.
                      </div>
                    )}

                  </div>

                  {/* Pagination Controls for Media */}
                  {ingestionStatus?.media_pagination &&
                    ingestionStatus.media_items.length > 0 && (
                      <div className="mt-6 flex flex-col items-center gap-3">
                        <p className="text-sm text-muted-foreground">
                          Showing {ingestionStatus.media_items.length} of{" "}
                          {ingestionStatus.media_pagination.total} media items
                        </p>
                        {ingestionStatus.media_pagination.hasMore && (
                          <Button
                            onClick={handleLoadMoreMedia}
                            disabled={loadingMoreMedia}
                            variant="outline"
                            className="min-w-[200px]"
                          >
                            {loadingMoreMedia ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Loading...
                              </>
                            ) : (
                              "Load More Media"
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}
