/**
 * Nút bánh răng ở header + màn hình Cài đặt. Chọn model và xoá dữ liệu bộ nhớ của Gừng.
 * Xoá phải bấm 2 lần (Alert của React Native không chạy trên web).
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  clearConversations,
  clearMemories,
  deleteMemory,
  getDataStats,
  getMemories,
  getSettings,
  setModel,
  type AppSettings,
  type DataStats,
  type Memory,
  type ModelFamily,
} from './api';
import { getDeviceId } from './config';
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
  const [confirming, setConfirming] = useState<Target | null>(null);
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
      setError(e instanceof Error ? e.message : 'Không kết nối được server');
    }
  }, []);

  useEffect(() => {
    Promise.all([getDataStats(), getMemories(), getSettings()])
      .then(([st, mem, set]) => {
        setStats(st);
        setMemories(mem);
        setSettings(set);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Không kết nối được server'));
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
      setError(e instanceof Error ? e.message : 'Không lưu được');
    }
  };

  // Bấm lần 1 mà không bấm tiếp trong 4 giây thì thôi.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const press = async (target: Target) => {
    if (busy) return;
    if (confirming !== target) {
      setConfirming(target);
      return;
    }
    setConfirming(null);
    setBusy(target);
    try {
      if (target !== 'history') await clearMemories();
      if (target !== 'memories') {
        await clearConversations();
        onHistoryCleared();
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Xoá không được');
    } finally {
      setBusy(null);
    }
  };

  // Xoá một ký ức (vd. Gừng nhớ nhầm): bấm một lần là xoá, mất ít nên không cần xác nhận.
  const removeMemory = async (id: number) => {
    if (removing !== null) return;
    setRemoving(id);
    try {
      await deleteMemory(id);
      setMemories((m) => m?.filter((x) => x.id !== id) ?? null);
      setStats((st) => (st ? { ...st, memories: st.memories - 1 } : st));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Xoá không được');
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
        style={[s.delBtn, confirming === target && s.delBtnConfirm]}
        accessibilityLabel={`${label}: ${title}`}
      >
        {busy === target ? (
          <ActivityIndicator color={C.error} />
        ) : (
          <Text style={[s.delText, confirming === target && s.delTextConfirm]}>
            {confirming === target ? 'Chắc chưa?' : label}
          </Text>
        )}
      </Pressable>
    </View>
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
                      onPress={() => removeMemory(m.id)}
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
        <Text style={s.note}>Luôn dùng bản mới nhất của dòng đã chọn. Áp dụng từ câu hỏi tiếp theo.</Text>

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
    </SafeAreaView>
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
  delBtnConfirm: { backgroundColor: C.error },
  delText: { fontSize: 15, fontWeight: '600', color: C.error },
  delTextConfirm: { color: '#FFFFFF' },
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
