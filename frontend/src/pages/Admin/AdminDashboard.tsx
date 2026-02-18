import { useState } from "react";
import AdminSidebar from "@/components/Admin/AdminSidebar";
import TextbookManagement from "@/components/Admin/DataSourceManagement";
import Analytics from "@/components/Admin/Analytics";
import AISettings from "@/components/Admin/AISettings";
import FAQsAndPrompts from "@/components/Admin/FAQsAndPrompts";
import Footer from "@/components/Footer";
import logoImage from "@/assets/specex-new-logo.png";

// --- Components ---

export default function AdminDashboard() {
  const [activeView, setActiveView] = useState<
    "dashboard" | "analytics" | "ai-settings" | "faqs-prompts" | "media" | "content-sections"
  >("dashboard");

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-gradient-to-r from-primary to-accent text-white h-[70px] flex items-center px-6 shadow-md z-10">
        <div className="flex items-center gap-2">
          <img src={logoImage} alt="Specialization Explorer AI Logo" className="h-10 w-auto" />
          <h1 className="text-xl font-semibold">Specialization Explorer AI Admin</h1>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <AdminSidebar activeView={activeView} onViewChange={setActiveView} />

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          {activeView === "dashboard" && <TextbookManagement />}
          {activeView === "analytics" && <Analytics />}
          {activeView === "ai-settings" && <AISettings />}
          {activeView === "faqs-prompts" && <FAQsAndPrompts />}
        </main>
      </div>
      <Footer />
    </div>
  );
}
