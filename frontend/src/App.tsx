import { Routes, Route } from "react-router";

import AppLayout from "./components/layout/AppLayout";
import OverviewPage from "./pages/OverviewPage";

function PageHeading({ title }: { title: string }) {
  return (
    <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
      {title}
    </h1>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<OverviewPage />} />

        <Route path="pipeline" element={<PageHeading title="Pipeline" />} />

        <Route path="profiles" element={<PageHeading title="Profiles" />} />

        <Route
          path="recommendations"
          element={<PageHeading title="Recommendations" />}
        />
      </Route>
    </Routes>
  );
}
