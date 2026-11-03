import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading } from '@/components/ui';
import { useAppFonts } from '@/lib/fonts';
import { SessionProvider, useSession } from '@/lib/session';
import { theme } from '@/lib/theme';

function RootNavigator() {
  const { ready, signedIn } = useSession();
  if (!ready) return <View style={{ flex: 1, backgroundColor: theme.night, justifyContent: 'center' }}><Loading onNight /></View>;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pool/[id]" />
        <Stack.Screen name="verify" options={{ presentation: 'modal' }} />
        <Stack.Screen name="receipt/[id]" options={{ presentation: 'modal' }} />
        <Stack.Screen name="statement/[id]" options={{ presentation: 'modal' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const fontsReady = useAppFonts();
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {fontsReady ? (
        <SessionProvider><RootNavigator /></SessionProvider>
      ) : <View style={{ flex: 1, backgroundColor: theme.night }} />}
    </SafeAreaProvider>
  );
}
