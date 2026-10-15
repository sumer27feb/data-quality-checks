import { Outlet } from "react-router";
import AppSidebar from "./AppSidebar";

export default function AppLayout() {
  return (
    <div className="min-h-screen bg-[#f7f9fc]">
      <AppSidebar />

      {/* Main workspace */}
      <main className="ml-64 min-h-screen px-8 py-7">
        <div className="mx-auto max-w-[1600px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
