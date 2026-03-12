import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Overview } from "./pages/Overview";
import { SkillReport } from "./pages/SkillReport";

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/skills/:name" element={<SkillReport />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
