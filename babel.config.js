// babel-preset-expo automatically configures the reanimated/worklets plugin
// for the installed SDK — do not add it manually (SDK 54 / Reanimated 4).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
