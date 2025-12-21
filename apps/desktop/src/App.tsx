import { HashRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import Devices from "./pages/Devices";
import { VPNProvider } from "./context/VPNContext";
import { TitleBar } from "./components/TitleBar";
import { ErrorBoundary } from "./components/ErrorBoundary";

function App() {
  return (
    <ErrorBoundary>
      <VPNProvider>
        <TitleBar />
        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <Router>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/login" element={<Login />} />
              <Route path="/devices" element={<Devices />} />
            </Routes>
          </Router>
        </div>
      </VPNProvider>
    </ErrorBoundary>
  );
}

export default App;
