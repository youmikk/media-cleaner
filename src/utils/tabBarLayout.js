// Both the floating bar and the three home lists use this clearance. System
// text scaling must not grow the bar over the last album or settings row.
export function getTabBarLayout({ width, fontScale = 1 }, insets, routeCount = 3) {
  const padding = 6;
  const available = Math.max(0, width - insets.left - insets.right - 32);
  const barWidth = Math.min(460, available);
  const tabWidth = Math.max(0, (barWidth - padding * 2) / routeCount);
  // Conservatively reserve wrapping space for the longest English tab label;
  // Chinese labels are shorter. No font scaling is disabled or capped.
  const lines = Math.max(1, Math.ceil((7 * 12 * fontScale * 0.65) / Math.max(1, tabWidth - 8)));
  const height = Math.max(72, padding * 2 + 24 + 3 + 8 + 16 * fontScale * lines);
  const bottom = Math.max(insets.bottom, 12);
  return { width: barWidth, tabWidth, padding, height, bottom, clearance: height + bottom + 20 };
}
