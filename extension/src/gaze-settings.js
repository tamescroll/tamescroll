// Smart blur's one setting, sites.youtube.smart: 'off' | 'women' | 'men'.
// The app asks the same question the same way (app/src/main.ts
// BlurChoice): "women" is Smart for a man, "men" is Smart for a woman.
// Anything else, including a setting from before this existed, is off.

export const SMART_CHOICES = [
  { id: 'off', label: 'Off' },
  { id: 'women', label: 'Women' },
  { id: 'men', label: 'Men' },
];

export function smartChoice(prefs) {
  const v = prefs && prefs.smart;
  return v === 'women' || v === 'men' ? v : 'off';
}

/** The runtime's declared gender, or null when Smart blur is off. */
export function gazeGender(prefs) {
  const c = smartChoice(prefs);
  return c === 'women' ? 'man' : c === 'men' ? 'woman' : null;
}

export const SMART_CAPTIONS = {
  off: '',
  women: 'Blurs women in videos, thumbnails and pictures on YouTube. The player has its own on/off switch. Faces it can\'t place stay covered.',
  men: 'Blurs men in videos, thumbnails and pictures on YouTube. The player has its own on/off switch. Faces it can\'t place stay covered.',
};
