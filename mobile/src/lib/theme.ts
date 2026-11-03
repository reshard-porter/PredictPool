/**
 * "Floodlit" theme: stadium-night indigo bands, floodlight amber for the one thing you act on,
 * turf mint for money that comes back, signal red for money you can lose.
 */
export const theme = {
  night: '#1B1A4A',        // hero bands, primary ink on light
  nightSoft: '#2A2966',    // raised surfaces on night
  nightLine: '#3B3A7A',    // hairlines on night
  onNight: '#FFFFFF',
  onNightMuted: '#B9B8E3',
  amber: '#FFC23D',        // selection + primary action
  amberDeep: '#8A5A00',    // amber text on light
  amberSoft: '#FFF3D6',
  mint: '#22B07D',         // refunds, credits, success
  mintDeep: '#0F7A54',
  mintSoft: '#DDF5EB',
  red: '#E5484D',          // fee, loss, errors
  redDeep: '#B4232A',
  redSoft: '#FDE6E7',
  bg: '#EEF0F7',           // pitch-line grey
  panel: '#FFFFFF',
  ink: '#1B1A4A',
  muted: '#6B6E8C',
  line: '#DFE2EE',
  info: '#3D4FB8',
  infoSoft: '#E5E8FA',
  // legacy aliases used by a few screens
  accent: '#1B1A4A', accentSoft: '#E5E8FA', warn: '#8A5A00', warnSoft: '#FFF3D6', bad: '#B4232A', badSoft: '#FDE6E7',
} as const;

export const font = {
  display: 'BarlowCondensed_700Bold',
  displayHeavy: 'BarlowCondensed_800ExtraBold',
  displayMedium: 'BarlowCondensed_600SemiBold',
  body: 'Barlow_400Regular',
  bodyMedium: 'Barlow_500Medium',
  bodySemi: 'Barlow_600SemiBold',
  bodyBold: 'Barlow_700Bold',
} as const;

// Type scale (≈ 1.25 ratio) — sizes in dp.
export const size = { xs: 12, sm: 14, md: 16, lg: 20, xl: 26, xxl: 34, hero: 48 } as const;
