import { LayoutDashboard, Workflow, Database, ShieldCheck } from "lucide-react";

import { Link, NavLink } from "react-router";

const navigation = [
  {
    name: "Overview",
    path: "/",
    icon: LayoutDashboard,
  },
  {
    name: "Pipeline",
    path: "/pipeline",
    icon: Workflow,
  },
  {
    name: "Profiles",
    path: "/profiles",
    icon: Database,
  },
  {
    name: "Recommendations",
    path: "/recommendations",
    icon: ShieldCheck,
  },
];

export default function AppSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-64 flex-col overflow-y-auto border-r border-white/10 bg-[#101e35] text-white">
      {/* Application branding */}
      <Link to="/" className="flex items-center gap-3 px-6 py-7">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-500/15">
          <ShieldCheck size={27} className="text-blue-400" />
        </div>

        <div>
          <h1 className="text-lg font-semibold tracking-tight">DQ Studio</h1>
          <p className="text-xs text-slate-400">Data Quality Analysis</p>
        </div>
      </Link>

      {/* Main navigation */}
      <nav
        aria-label="Main navigation"
        className="mt-7 flex flex-col gap-2 px-3"
      >
        {navigation.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-[#244a82] text-white"
                    : "text-slate-300 hover:bg-white/10 hover:text-white",
                ].join(" ")
              }
            >
              <Icon size={19} strokeWidth={1.9} />
              <span>{item.name}</span>
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
