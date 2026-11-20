/**
 * Nút bánh răng ở header + màn hình Cài đặt. Chọn model và xoá dữ liệu bộ nhớ của Gừng.
 * Xoá thì hiện popup hỏi lại (tự vẽ bằng Modal, vì Alert của React Native không chạy trên web).
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  clearConversations,
  clearMemories,
  deleteMemory,
  getDataStats,
  getMemories,
  getSettings,
  setModel,
  setVoiceIsolation,
  type AppSettings,
  type DataStats,
  type Memory,
  type ModelFamily,
} from './api';
import { getDeviceId } from './config';
import { friendlyError } from './errors';
import { BackIcon, C, GearIcon, styles as ui } from './ui';

type Props = {
  /** Đang trò chuyện thì không cho mở cài đặt (xoá dữ liệu giữa chừng sẽ rối). */
  disabled?: boolean;
  /** Lịch sử đã bị xoá: màn hình giọng nói bỏ ID cuộc trò chuyện đang nhớ. */
  onHistoryCleared: () => void;
};

export function SettingsButton({ disabled, onHistoryCleared }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <View style={ui.headerAction}>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        hitSlop={8}
        style={[ui.headerBtn, disabled && { opacity: 0.35 }]}
        accessibilityLabel="Cài đặt"
      >
        <GearIcon />
      </Pressable>
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <SettingsSheet onClose={() => setOpen(false)} onHistoryCleared={onHistoryCleared} />
      </Modal>
    </View>
  );
}

type Target = 'memories' | 'history' | 'all';

const FAMILY_LABEL: Record<ModelFamily, { title: string; hint: string }> = {
  haiku: { title: 'Haiku', hint: 'Nhanh, rẻ, trả lời đơn giản' },
  sonnet: { title: 'Sonnet', hint: 'Cân bằng giữa nhanh và hay' },
  opus: { title: 'Opus', hint: 'Sâu sắc nhất, chậm và đắt hơn' },
};

function SettingsSheet({ onClose, onHistoryCleared }: { onClose: () => void; onHistoryCleared: () => void }) {
  const [stats, setStats] = useState<DataStats | null>(null);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Đang hỏi lại trước khi xoá: cả một nhóm dữ liệu, hoặc một ký ức.
  const [confirming, setConfirming] = useState<{ target: Target } | { memory: Memory } | null>(null);
  const [busy, setBusy] = useState<Target | null>(null);
  // Trang con: danh sách từng ký ức (mở khi bấm vào dòng "Ký ức của Gừng").
  const [page, setPage] = useState<'main' | 'memories'>('main');

  const load = useCallback(async () => {
    try {
      const [st, mem] = await Promise.all([getDataStats(), getMemories()]);
      setStats(st);
      setMemories(mem);
      setError(null);
    } catch (e) {
      setError(friendlyError(e, 'Không kết nối được server'));
    }
  }, []);

  useEffect(() => {
    Promise.all([getDataStats(), getMemories(), getSettings()])
      .then(([st, mem, set]) => {
        setStats(st);
        setMemories(mem);
        setSettings(set);
      })
      .catch((e) => setError(friendlyError(e, 'Không kết nối được server')));
  }, []);

  // Đổi ngay trên giao diện; lưu lỗi thì quay về lựa chọn cũ.
  const chooseModel = async (family: ModelFamily) => {
    if (!settings || settings.model === family) return;
    const before = settings.model;
    setSettings({ ...settings, model: family });
    try {
      await setModel(family);
      setError(null);
    } catch (e) {
      setSettings((cur) => (cur ? { ...cur, model: before } : cur));
      setError(friendlyError(e, 'Không lưu được'));
    }
  };

  const toggleVoiceIsolation = async (on: boolean) => {
    if (!settings) return;
    setSettings({ ...settings, voice_isolation: on });
    try {
      await setVoiceIsolation(on);
      setError(null);
    } catch (e) {
      setSettings((cur) => (cur ? { ...cur, voice_isolation: !on } : cur));
      setError(friendlyError(e, 'Không lưu được'));
    }
  };

  // Bấm "Xoá" mở popup hỏi lại; bấm "Xoá" trong popup mới xoá thật.
  const press = (target: Target) => {
    if (!busy) setConfirming({ target });
  };

  const confirmDelete = () => {
    const ask = confirming;
    setConfirming(null);
    if (!ask) return;
    if ('memory' in ask) removeMemory(ask.memory.id);
    else clearTarget(ask.target);
  };

  const clearTarget = async (target: Target) => {
    setBusy(target);
    try {
      if (target !== 'history') await clearMemories();
      if (target !== 'memories') {
        await clearConversations();
        onHistoryCleared();
      }
      await load();
    } catch (e) {
      setError(friendlyError(e, 'Xoá không được'));
    } finally {
      setBusy(null);
    }
  };

  // Xoá một ký ức (vd. Gừng nhớ nhầm), sau khi popup hỏi lại.
  const removeMemory = async (id: number) => {
    if (removing !== null) return;
    setRemoving(id);
    try {
      await deleteMemory(id);
      setMemories((m) => m?.filter((x) => x.id !== id) ?? null);
      setStats((st) => (st ? { ...st, memories: st.memories - 1 } : st));
    } catch (e) {
      setError(friendlyError(e, 'Xoá không được'));
    } finally {
      setRemoving(null);
    }
  };

  const row = (target: Target, title: string, detail: string | null, label: string, onOpen?: () => void) => (
    <View style={s.row}>
      <Pressable
        onPress={onOpen}
        disabled={!onOpen}
        style={({ pressed }) => [s.rowText, s.rowOpen, pressed && s.rowPressed]}
        accessibilityLabel={onOpen ? `Xem ${title}` : undefined}
      >
        <View style={s.rowText}>
          <Text style={s.rowTitle}>{title}</Text>
          {detail ? <Text style={s.rowDetail}>{detail}</Text> : null}
        </View>
        {onOpen && <Text style={s.chevron}>›</Text>}
      </Pressable>
      <Pressable
        onPress={() => press(target)}
        style={s.delBtn}
        accessibilityLabel={`${label}: ${title}`}
      >
        {busy === target ? <ActivityIndicator color={C.error} /> : <Text style={s.delText}>{label}</Text>}
      </Pressable>
    </View>
  );

  const dialog = (
    <ConfirmDialog
      text={
        confirming === null
          ? null
          : 'memory' in confirming
            ? {
                title: 'Xoá ký ức này?',
                message: `Gừng sẽ quên: “${confirming.memory.content}”`,
                action: 'Xoá',
              }
            : CONFIRM[confirming.target]
      }
      onCancel={() => setConfirming(null)}
      onConfirm={confirmDelete}
    />
  );

  if (page === 'memories') {
    return (
      <SafeAreaView style={ui.safe} edges={['top', 'bottom']}>
        <View style={s.top}>
          <Pressable onPress={() => setPage('main')} hitSlop={8} style={s.back} accessibilityLabel="Quay lại Cài đặt">
            <BackIcon />
          </Pressable>
          <Text style={s.title}>Ký ức của Gừng</Text>
          <Pressable onPress={onClose} hitSlop={8} style={s.done}>
            <Text style={s.doneText}>Xong</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={s.body}>
          <View style={s.card}>
            {memories === null ? (
              <ActivityIndicator color={C.primary} style={s.memLoading} />
            ) : memories.length === 0 ? (
              <Text style={s.memEmpty}>Gừng chưa nhớ gì cả.</Text>
            ) : (
              memories.map((m, i) => (
                <View key={m.id}>
                  {i > 0 && <View style={s.sep} />}
                  <View style={s.memRow}>
                    <Text style={s.memText}>{m.content}</Text>
                    <Pressable
                      onPress={() => removing === null && setConfirming({ memory: m })}
                      hitSlop={8}
                      style={s.memDel}
                      accessibilityLabel={`Xoá ký ức: ${m.content}`}
                    >
                      {removing === m.id ? (
                        <ActivityIndicator size="small" color={C.error} />
                      ) : (
                        <Text style={s.memDelText}>✕</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </View>
          <Text style={s.note}>Gừng nhớ nhầm điều gì thì bấm ✕ để xoá điều đó.</Text>
          {error && <Text style={ui.error}>{error}</Text>}
        </ScrollView>
        {dialog}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={ui.safe} edges={['top', 'bottom']}>
      <View style={s.top}>
        <Text style={s.title}>Cài đặt</Text>
        <Pressable onPress={onClose} hitSlop={8} style={s.done}>
          <Text style={s.doneText}>Xong</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.section}>MODEL TRẢ LỜI</Text>
        <View style={s.card}>
          {settings === null ? (
            <ActivityIndicator color={C.primary} style={s.memLoading} />
          ) : (
            settings.models.map((m, i) => {
              const selected = m.family === settings.model;
              return (
                <View key={m.family}>
                  {i > 0 && <View style={s.sep} />}
                  <Pressable
                    onPress={() => chooseModel(m.family)}
                    style={({ pressed }) => [s.row, pressed && s.rowPressed]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${FAMILY_LABEL[m.family].title}: ${FAMILY_LABEL[m.family].hint}`}
                  >
                    <View style={s.rowText}>
                      <Text style={s.rowTitle}>{FAMILY_LABEL[m.family].title}</Text>
                      <Text style={s.rowDetail}>{FAMILY_LABEL[m.family].hint}</Text>
                    </View>
                    <Text style={[s.check, !selected && s.checkOff]}>✓</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>

        <Text style={s.section}>NGHE</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={s.rowText}>
              <Text style={s.rowTitle}>Lọc giọng xung quanh</Text>
            </View>
            {settings === null ? (
              <ActivityIndicator color={C.primary} />
            ) : (
              <Switch
                value={settings.voice_isolation}
                onValueChange={toggleVoiceIsolation}
                trackColor={{ true: C.listening }}
                accessibilityLabel="Lọc giọng xung quanh"
              />
            )}
          </View>
        </View>

        <Text style={s.section}>BỘ NHỚ CỦA GỪNG</Text>
        <View style={s.card}>
          {row(
            'memories',
            'Ký ức của Gừng',
            stats ? `Gừng đang nhớ ${stats.memories} điều` : null,
            'Xoá',
            () => setPage('memories'),
          )}
          <View style={s.sep} />
          {row(
            'history',
            'Lịch sử trò chuyện',
            stats ? `${stats.conversations} cuộc trò chuyện, kèm bản tóm tắt` : null,
            'Xoá',
          )}
          <View style={s.sep} />
          {row('all', 'Xoá tất cả', 'Gừng sẽ quên hết mọi chuyện', 'Xoá hết')}
        </View>
        <Text style={s.note}>Dữ liệu đã xoá không khôi phục được.</Text>
        {error && <Text style={ui.error}>{error}</Text>}
        {/* Mỗi máy một tài khoản; mã này để tra tài khoản trong DB khi cần. */}
        <Text style={s.deviceId}>Mã thiết bị: {getDeviceId().slice(0, 8)}</Text>
      </ScrollView>
      {dialog}
    </SafeAreaView>
  );
}

type DialogText = { title: string; message: string; action: string };

const CONFIRM: Record<Target, DialogText> = {
  memories: {
    title: 'Xoá hết ký ức?',
    message: 'Gừng sẽ quên mọi điều đã nhớ. Không khôi phục được.',
    action: 'Xoá',
  },
  history: {
    title: 'Xoá lịch sử trò chuyện?',
    message: 'Mọi cuộc trò chuyện và bản tóm tắt sẽ bị xoá. Không khôi phục được.',
    action: 'Xoá',
  },
  all: {
    title: 'Xoá tất cả?',
    message: 'Gừng sẽ quên hết mọi chuyện: ký ức, lịch sử và bản tóm tắt. Không khôi phục được.',
    action: 'Xoá hết',
  },
};

/** Popup hỏi lại trước khi xoá. Tự vẽ bằng Modal vì Alert của React Native không chạy trên web. */
function ConfirmDialog({
  text: current,
  onCancel,
  onConfirm,
}: {
  text: DialogText | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Giữ nội dung lúc popup đang mờ dần sau khi đóng.
  const [shown, setShown] = useState<DialogText>(current ?? CONFIRM.all);
  if (current && current.title + current.message !== shown.title + shown.message) setShown(current);
  const text = current ?? shown;
  return (
    <Modal visible={current !== null} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={s.backdrop} onPress={onCancel} accessibilityLabel="Huỷ">
        <Pressable style={s.dialog} accessibilityRole="alert">
          <Text style={s.dialogTitle}>{text.title}</Text>
          <Text style={s.dialogMessage}>{text.message}</Text>
          <View style={s.dialogButtons}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [s.dialogBtn, s.dialogCancel, pressed && s.rowPressed]}
            >
              <Text style={s.dialogCancelText}>Huỷ</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={({ pressed }) => [s.dialogBtn, s.dialogDelete, pressed && s.rowPressed]}
            >
              <Text style={s.dialogDeleteText}>{text.action}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  top: {
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
  },
  title: { fontSize: 18, fontWeight: '600', color: C.ink },
  done: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center' },
  doneText: { fontSize: 17, fontWeight: '600', color: C.listening },
  body: { padding: 16, gap: 8 },
  section: { fontSize: 13, color: C.muted, marginTop: 8, marginLeft: 4, letterSpacing: 0.5 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, gap: 12 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, color: C.ink },
  rowDetail: { fontSize: 13, color: C.muted },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 16 },
  delBtn: {
    minWidth: 92,
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.error,
  },
  delText: { fontSize: 15, fontWeight: '600', color: C.error },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, gap: 8 },
  dialogTitle: { fontSize: 18, fontWeight: '600', color: C.ink, textAlign: 'center' },
  dialogMessage: { fontSize: 15, lineHeight: 21, color: C.muted, textAlign: 'center' },
  dialogButtons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  dialogBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12 },
  dialogCancel: { backgroundColor: C.line },
  dialogCancelText: { fontSize: 16, fontWeight: '600', color: C.ink },
  dialogDelete: { backgroundColor: C.error },
  dialogDeleteText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  note: { fontSize: 13, color: C.muted, marginLeft: 4 },
  back: { position: 'absolute', left: 10, top: 0, bottom: 0, justifyContent: 'center' },
  rowOpen: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowPressed: { opacity: 0.5 },
  chevron: { fontSize: 24, color: C.muted, marginRight: 4 },
  memRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingLeft: 16, paddingRight: 8, gap: 8 },
  memText: { flex: 1, fontSize: 15, lineHeight: 21, color: C.ink },
  memDel: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  memDelText: { fontSize: 16, color: C.muted },
  memLoading: { paddingVertical: 20 },
  deviceId: { fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 24 },
  check: { width: 24, fontSize: 18, fontWeight: '700', color: C.listening, textAlign: 'center' },
  checkOff: { opacity: 0 },
  memEmpty: { paddingVertical: 16, paddingHorizontal: 16, fontSize: 15, color: C.muted },
});
