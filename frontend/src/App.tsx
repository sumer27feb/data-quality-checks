import { Routes, Route } from "react-router";

import AppLayout from "./components/layout/AppLayout";
import OverviewPage from "./pages/OverviewPage";
import PipelinePage from "./pages/PipelinePage";
import ProfilesPage from "./pages/ProfilesPage";
import RecommendationsPage from "./pages/RecommendationsPage";
import ReusableRunsPage from "./pages/ReusableRunsPage";
import ScopedRecommendationsPage from "./pages/ScopedRecommendationsPage";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="profiles" element={<ProfilesPage />} />
        <Route path="recommendations" element={<RecommendationsPage />} />
        <Route path="reusable-runs" element={<ReusableRunsPage />} />
        <Route path="scoped-recommendations" element={<ScopedRecommendationsPage />} />
      </Route>
    </Routes>
  );
}
