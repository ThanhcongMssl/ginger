/**
 * Chế độ gõ chữ: dùng khi không tiện nói hoặc chỗ ồn. Cùng cuộc trò chuyện và bộ nhớ
 * với chế độ nói (src/conversation.ts), câu trả lời stream từ `POST /chat`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getMessages, sendChat, type ChatMessage } from './api';
import { conversation } from './conversation';
import { SettingsButton } from './Settings';
import { C, HeaderButton, Logo, MicIcon, SendIcon, styles as ui } from './ui';

export default function ChatScreen({ onVoiceMode }: { onVoiceMode: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(conversation.current !== null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const abort = useRef<AbortController | null>(null);
  // Rời màn hình chat thì dừng câu trả lời đang chạy.
  useEffect(() => () => abort.current?.abort(), []);

  // Hiện lại những gì đã nói/gõ trong cuộc trò chuyện đang mở.
  useEffect(() => {
    const id = conversation.current;
    if (!id) return;
    getMessages(id)
      .then(setMessages)
      .catch((e) => setError(e instanceof Error ? e.message : 'Không tải được tin nhắn'))
      .finally(() => setLoading(false));
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setError(null);
    setSending(true);
    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    // Ghép từng đoạn chữ vào tin cuối (tin của Ginger đang viết dở).
    const appendToLast = (delta: string) =>
      setMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: m[m.length - 1].content + delta }]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await sendChat(
        text,
        conversation.current,
        { onDelta: appendToLast, onConversationId: (id) => (conversation.current = id) },
        controller.signal,
      );
    } catch (e) {
      if (controller.signal.aborted) {
        // Anh bấm dừng: giữ phần đã trả lời, bỏ bong bóng trống nếu Ginger chưa kịp viết gì.
        setMessages((m) => (m[m.length - 1]?.content ? m : m.slice(0, -1)));
        return;
      }
      setError(e instanceof Error ? e.message : 'Không gửi được');
      // Bỏ tin trống của Ginger, trả lại chữ vào ô nhập để anh gửi lại.
      setMessages((m) => (m[m.length - 1]?.content ? m : m.slice(0, -2)));
      setInput(text);
    } finally {
      abort.current = null;
      setSending(false);
    }
  }, [input, sending]);

  const stop = useCallback(() => abort.current?.abort(), []);

  const last = messages[messages.length - 1];
  const waiting = sending && last?.role === 'assistant' && !last.content;

  return (
    <SafeAreaView style={ui.safe} edges={['top', 'bottom']}>
      <View style={ui.header}>
        <HeaderButton side="left" label="Nói chuyện" disabled={sending} onPress={onVoiceMode}>
          <MicIcon size={24} color={C.ink} />
        </HeaderButton>
        <Logo />
        <SettingsButton
          disabled={sending}
          onHistoryCleared={() => {
            conversation.current = null;
            setMessages([]);
          }}
        />
      </View>

      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scroll}
          style={s.flex}
          contentContainerStyle={s.list}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {loading && <ActivityIndicator color={C.primary} style={s.loading} />}
          {!loading && messages.length === 0 && (
            <Text style={s.empty}>Cần gì cứ nhắn cho Gừng nhé.</Text>
          )}
          {messages.map((m, i) =>
            m.role === 'assistant' && !m.content ? null : (
              <View key={i} style={[s.bubble, m.role === 'user' ? s.userBubble : s.botBubble]}>
                <Text style={s.text} selectable>
                  {m.content}
                </Text>
              </View>
            ),
          )}
          {waiting && (
            <View style={[s.bubble, s.botBubble]}>
              <ActivityIndicator size="small" color={C.muted} />
            </View>
          )}
          {error && <Text style={ui.error}>{error}</Text>}
        </ScrollView>

        <View style={s.composer}>
          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="Nhắn cho Gừng…"
            placeholderTextColor={C.muted}
            multiline
            // Web: textarea mặc định cao 2 dòng.
            rows={Platform.OS === 'web' ? 1 : undefined}
            maxLength={8000}
            submitBehavior="submit"
            onSubmitEditing={send}
            returnKeyType="send"
            // Web: ô nhiều dòng không gọi onSubmitEditing. Enter = gửi, Shift+Enter = xuống dòng.
            onKeyPress={
              Platform.OS === 'web'
                ? (e) => {
                    const ev = e.nativeEvent as unknown as KeyboardEvent;
                    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }
                : undefined
            }
          />
          {sending ? (
            <Pressable onPress={stop} style={s.stopBtn} accessibilityLabel="Dừng trả lời">
              <View style={s.stopIcon} />
            </Pressable>
          ) : (
            <Pressable
              onPress={send}
              disabled={!input.trim()}
              style={[s.sendBtn, !input.trim() && s.sendBtnOff]}
              accessibilityLabel="Gửi"
            >
              <SendIcon />
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 16, gap: 10, flexGrow: 1 },
  loading: { marginTop: 24 },
  empty: { marginTop: 48, fontSize: 16, color: C.muted, textAlign: 'center' },
  bubble: { maxWidth: '85%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: C.primary, borderBottomRightRadius: 6 },
  botBubble: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF', borderBottomLeftRadius: 6 },
  text: { fontSize: 16, lineHeight: 22, color: C.ink },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.line,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 42,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: '#FFFFFF',
    fontSize: 16,
    color: C.ink,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  sendBtnOff: { opacity: 0.4 },
  stopBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.ink,
  },
  stopIcon: { width: 14, height: 14, borderRadius: 3, backgroundColor: C.bg },
});
