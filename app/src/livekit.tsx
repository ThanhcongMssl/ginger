/**
 * LiveKit cho app native (dev build). Bản web nằm ở livekit.web.tsx, cùng các export này.
 */
import { AudioSession, LiveKitRoom, registerGlobals, useTrackVolume } from '@livekit/react-native';
import type { LocalAudioTrack, RemoteAudioTrack } from 'livekit-client';
import type { ReactNode } from 'react';

export { useLocalParticipant, useRoomContext, useVoiceAssistant } from '@livekit/react-native';

registerGlobals();

/** Native không có MediaRecorder nên không có bộ đệm trước khi agent vào (xem livekit.web.tsx). */
export const PRECONNECT_BUFFER = false;

/** Bật phiên audio của iOS/Android (loa ngoài, khử vọng) trước khi vào phòng. */
export async function startAudio(): Promise<void> {
  await AudioSession.startAudioSession();
}

export function stopAudio(): void {
  AudioSession.stopAudioSession();
}

/** Âm lượng RMS (0..1, tuyến tính) của một track, cập nhật liên tục. */
export function useAudioLevel(track: LocalAudioTrack | RemoteAudioTrack | undefined): number {
  return useTrackVolume(track);
}

export type RoomProps = {
  serverUrl: string;
  token: string;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (e: Error) => void;
  children: ReactNode;
};

export function Room({ children, ...props }: RoomProps) {
  return (
    <LiveKitRoom
      {...props}
      connect
      audio={{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }}
      video={false}
    >
      {children}
    </LiveKitRoom>
  );
}
