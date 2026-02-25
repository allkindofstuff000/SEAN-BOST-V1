import { 
  LayoutDashboard, 
  Users, 
  Settings, 
  ShieldCheck 
} from "lucide-react";

export default function Navbar() {
  return (
    <div className="bg-card px-8 py-4 flex justify-between items-center shadow-md">
      
      {/* Left Side */}
      <div className="flex items-center gap-10">
        
        <div className="text-xl font-bold flex items-center gap-2">
          ðŸš€ <span>MEGABOOSTV1</span>
        </div>

        <nav className="flex gap-8 text-sm font-medium items-center">
          
          <a href="#" className="flex items-center gap-2 hover:text-accent transition">
            <LayoutDashboard size={18} />
            Dashboard
          </a>

          <a href="#" className="flex items-center gap-2 hover:text-accent transition">
            <Users size={18} />
            Accounts
          </a>

          <a href="#" className="flex items-center gap-2 hover:text-accent transition">
            <Settings size={18} />
            Settings
          </a>

        </nav>
      </div>

      {/* Right Side */}
      <div className="flex items-center gap-6 text-sm">

        <div className="flex items-center gap-2 bg-green-600 px-3 py-1 rounded-full">
          <ShieldCheck size={16} />
          Active License
        </div>

        <div className="opacity-80">
          Expires: 2026-07-23
        </div>

        <div className="bg-primary px-3 py-1 rounded-full border border-red-400">
          Seanbot2
        </div>
      </div>
    </div>
  );
}
