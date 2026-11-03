import { View } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AccountIcon, EntriesIcon, PoolsIcon, WalletIcon } from '@/components/icons';
import { font, theme } from '@/lib/theme';

/** Active tab: night ink with an amber floodlight bar above the icon. */
function TabIcon({ focused, color, Icon }: { focused: boolean; color: string; Icon: (p: { color: string }) => React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: 22, height: 3, borderRadius: 2, marginBottom: 5, backgroundColor: focused ? theme.amber : 'transparent' }} />
      <Icon color={color} />
    </View>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: theme.night,
      tabBarInactiveTintColor: '#9497B3',
      tabBarStyle: { backgroundColor: '#fff', borderTopColor: theme.line, height: 70 + insets.bottom, paddingTop: 0, paddingBottom: Math.max(insets.bottom, 8) },
      tabBarLabelStyle: { fontSize: 12, lineHeight: 16, fontFamily: font.bodySemi },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Pools', tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={String(color)} Icon={PoolsIcon} /> }} />
      <Tabs.Screen name="entries" options={{ title: 'My entries', tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={String(color)} Icon={EntriesIcon} /> }} />
      <Tabs.Screen name="wallet" options={{ title: 'Wallet', tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={String(color)} Icon={WalletIcon} /> }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={String(color)} Icon={AccountIcon} /> }} />
    </Tabs>
  );
}
