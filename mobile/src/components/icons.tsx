import Svg, { Circle, Path, Rect } from 'react-native-svg';

type P = { color: string; size?: number };
const base = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const });

export const PoolsIcon = ({ color, size = 24 }: P) => (
  <Svg {...base(size)}><Circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth={2} />
    <Path d="M8.2 12.3l2.6 2.6 5-5.4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>
);
export const EntriesIcon = ({ color, size = 24 }: P) => (
  <Svg {...base(size)}><Rect x="5" y="3.5" width="14" height="17" rx="2.5" stroke={color} strokeWidth={2} />
    <Path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke={color} strokeWidth={2} strokeLinecap="round" /></Svg>
);
export const WalletIcon = ({ color, size = 24 }: P) => (
  <Svg {...base(size)}><Rect x="3" y="6" width="18" height="13" rx="2.5" stroke={color} strokeWidth={2} />
    <Path d="M3 9.5h18M15.5 14h2" stroke={color} strokeWidth={2} strokeLinecap="round" /></Svg>
);
export const AccountIcon = ({ color, size = 24 }: P) => (
  <Svg {...base(size)}><Circle cx="12" cy="8.5" r="3.8" stroke={color} strokeWidth={2} />
    <Path d="M4.5 20c1.2-3.6 4-5.2 7.5-5.2s6.3 1.6 7.5 5.2" stroke={color} strokeWidth={2} strokeLinecap="round" /></Svg>
);
