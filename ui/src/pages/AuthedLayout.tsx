import { Outlet, useParams } from "react-router-dom";

import { RoomsSidebar } from "@/components/RoomsSidebar";

export function AuthedLayout() {
  const { roomId: roomIdParam } = useParams();
  const roomId = roomIdParam ? decodeURIComponent(roomIdParam) : null;

  return (
    <div className="grid min-h-svh grid-cols-1 bg-[var(--app-bg)] md:grid-cols-[320px_1fr]">
      <div className="hidden md:block">
        <RoomsSidebar selectedRoomId={roomId} />
      </div>

      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

