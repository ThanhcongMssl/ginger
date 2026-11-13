/**
 * Bản dev có bundle ID riêng (`.dev`) để cài song song với bản preview trên cùng iPhone.
 * APP_VARIANT=development được đặt trong eas.json (profile development); khi chạy Metro
 * cho dev build cũng đặt biến này để manifest khớp với app đã cài.
 */
const IS_DEV = process.env.APP_VARIANT === 'development';

module.exports = ({ config }) => {
  if (!IS_DEV) return config;
  return {
    ...config,
    name: 'Ginger Dev',
    ios: { ...config.ios, bundleIdentifier: `${config.ios.bundleIdentifier}.dev` },
    android: { ...config.android, package: `${config.android.package}.dev` },
  };
};
