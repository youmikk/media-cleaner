const { AndroidConfig, withInfoPlist, withStringsXml } = require('expo/config-plugins');

module.exports = function withAppDisplayName(config, { displayName } = {}) {
  if (typeof displayName !== 'string' || !displayName.trim()) {
    throw new Error('withAppDisplayName requires a non-empty displayName.');
  }
  const name = displayName.trim();

  // expo.name also names the Xcode project, scheme and .app used by CI.
  // Change only the user-visible labels so existing build paths stay valid.
  config = withInfoPlist(config, config => {
    config.modResults.CFBundleDisplayName = name;
    return config;
  });

  return withStringsXml(config, config => {
    config.modResults = AndroidConfig.Strings.setStringItem(
      [AndroidConfig.Resources.buildResourceItem({ name: 'app_name', value: name })],
      config.modResults
    );
    return config;
  });
};
