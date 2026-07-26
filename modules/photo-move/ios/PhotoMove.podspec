Pod::Spec.new do |s|
  s.name           = 'PhotoMove'
  s.version        = '1.0.0'
  s.summary        = 'Native photo helpers (EXIF via ImageIO, fast gray decode)'
  s.description    = 'Local Expo module: EXIF reading and fast subsampled decodes.'
  s.author         = 'MediaCleaner'
  s.homepage       = 'https://github.com/youmikk/media-cleaner'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.license        = { :type => 'MIT' }

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
