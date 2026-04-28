import { Navigate, Route, Routes } from "react-router-dom";
import { MatrixProvider, useMatrix } from "@/lib/matrix/MatrixProvider";
import { LoginPage } from "@/pages/Login";
import { AuthedLayout } from "@/pages/AuthedLayout";
import { RoomChatPage } from "@/pages/RoomChat";

function RequireAuth(props: { children: React.ReactNode }) {
  const { session } = useMatrix();
  if (!session) return <Navigate to="/login" replace />;
  return props.children;
}

function App() {
  return (
    <MatrixProvider>
      <div className="min-h-svh">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <AuthedLayout />
              </RequireAuth>
            }
          >
            <Route
              path="rooms"
              element={
                <div className="flex h-svh min-h-svh items-center justify-center px-6 text-center">
                  <div>
                    <div className="text-lg font-semibold">Select a chat</div>
                    <div className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
                      Choose room from left.
                    </div>
                  </div>
                </div>
              }
            />
            <Route path="room/:roomId" element={<RoomChatPage />} />
            <Route path="*" element={<Navigate to="/rooms" replace />} />
          </Route>
        </Routes>
      </div>
    </MatrixProvider>
  );
}

export default App;
