/**
 * Bản web và bản preview/App Store không chứa token: lần đầu mở, anh dán APP_TOKEN (trong
 * backend/.env), em kiểm tra với server rồi lưu lại (web: localStorage, native: Keychain).
 * Dev build có sẵn token trong app/.env nên bỏ qua màn này.
 * Cũng nạp mã thiết bị (tài khoản) ở đây để mọi request sau đều có.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { checkAppToken } from './api';
import { getAppToken, getDeviceId, loadAppToken, loadDeviceId, setAppToken } from './config';
import { C, Logo, styles } from './ui';

export default function TokenGate({ children }: { children: ReactNode }) {
  // null = đang đọc token đã lưu.
  const [ok, setOk] = useState<boolean | null>(null);
  const [noDevice, setNoDevice] = useState(false);
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadAppToken(), loadDeviceId()]).then(() => {
      setNoDevice(getDeviceId() === '');
      setOk(getAppToken() !== '');
    });
  }, []);

  if (ok === null) return null;
  if (noDevice) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Logo />
        </View>
        <View style={styles.gate}>
          <Text style={styles.gateLabel}>Bản app này đã cũ, cần cài bản mới để dùng tiếp.</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (ok) return children;

  const submit = async () => {
    const token = value.trim();
    if (!token || checking) return;
    setChecking(true);
    setError(null);
    try {
      if (await checkAppToken(token)) {
        setAppToken(token);
        setOk(true);
      } else {
        setError('Token không đúng');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không kết nối được server');
    } finally {
      setChecking(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Logo />
      </View>
      <View style={styles.gate}>
        <Text style={styles.gateLabel}>Nhập token truy cập</Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          onSubmitEditing={submit}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="APP_TOKEN"
          placeholderTextColor={C.muted}
          style={styles.gateInput}
        />
        <Pressable onPress={submit} style={styles.gateBtn} disabled={checking}>
          {checking ? <ActivityIndicator color={C.ink} /> : <Text style={styles.gateBtnText}>Vào</Text>}
        </Pressable>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </SafeAreaView>
  );
}
