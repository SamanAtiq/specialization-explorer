import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Menu, X } from "lucide-react";
import { useSidebar } from "@/providers/sidebar";
import { Link, useLocation, useNavigate } from "react-router";
import logoImage from "@/assets/SpecEx_logo_black.png";

type Mode = "student" | "admin";

export default function Header() {
  const { mobileOpen, toggleMobile } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();

  const mode: Mode = location.pathname.startsWith("/admin") ? "admin" : "student";

  const handleModeChange = (newMode: Mode) => {
    if (newMode === "admin") {
      navigate("/admin/login");
    } else {
      navigate("/");
    }
  };

  return (
    <header className="bg-gradient-to-r from-primary to-accent text-white h-[80px] flex items-center px-6 shadow-md z-10">
      <div className="w-full flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleMobile}
            aria-label="Toggle menu"
            aria-expanded={mobileOpen}
            className="md:hidden p-2 rounded-md hover:bg-white/10"
          >
            {mobileOpen ? (
              <X className="h-5 w-5 text-white" />
            ) : (
              <Menu className="h-5 w-5 text-white" />
            )}
          </button>

          <Link
            to="/"
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            aria-label="Navigate to home"
          >
            <img src={logoImage} alt="Specialization Explorer AI Logo" className="h-10 w-auto" />
            <h1 className="text-xl font-semibold text-white">
              Specialization Explorer AI
            </h1>
          </Link>
        </div>

        <Select value={mode} onValueChange={(v) => handleModeChange(v as Mode)}>
          <SelectTrigger className="w-fit border-primary-foreground bg-transparent text-white [&_svg:not([class*='text-'])]:text-primary-foreground hover:bg-white/10">
            <SelectValue placeholder="Select mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="student">Mode: Student</SelectItem>
            <SelectItem value="admin">Mode: Admin</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </header>
  );
}

// {/* Header */}
//       <header className="bg-gradient-to-r from-primary to-accent text-white h-[70px] flex items-center px-6 shadow-md z-10">
//         <div className="flex items-center gap-2">
//           <img src={logoImage} alt="Specialization Explorer AI Logo" className="h-10 w-auto" />
//           <h1 className="text-xl font-semibold">Specialization Explorer AI Admin</h1>
//         </div>
//       </header>
