import { Fredoka_700Bold, useFonts } from '@expo-google-fonts/fredoka';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { useState, type ComponentType } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ChatScreen from './src/ChatScreen';
import ExpoGoVoice from './src/ExpoGoVoice';
import TokenGate from './src/TokenGate';

// Expo Go không có native module của LiveKit (WebRTC), nên chỉ nạp LiveVoice ở dev build.
// Bản web (Safari) cũng dùng LiveVoice, qua src/livekit.web.tsx.
// Expo Go dùng bản half-duplex qua WebSocket (không ngắt lời bằng giọng được).
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const VoiceScreen: ComponentType<{ onTextMode: () => void }> = isExpoGo ? ExpoGoVoice : require('./src/LiveVoice').default;

export default function App() {
  const [fontsLoaded] = useFonts({ Fredoka_700Bold });
  // Gõ chữ khi không tiện nói hoặc chỗ ồn; hai chế độ dùng chung cuộc trò chuyện.
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <TokenGate>
        {mode === 'voice' ? (
          <VoiceScreen onTextMode={() => setMode('text')} />
        ) : (
          <ChatScreen onVoiceMode={() => setMode('voice')} />
        )}
      </TokenGate>
    </SafeAreaProvider>
  );
}
