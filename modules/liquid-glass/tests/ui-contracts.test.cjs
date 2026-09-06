const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const babel = require('@babel/core');
const React = require('react');

const root = path.resolve(__dirname, '../../..');
const compiled = new Map();
let instance = 0;
const flatten = value => Array.isArray(value)
  ? Object.assign({}, ...value.filter(Boolean).map(flatten)) : value || {};

// Shallow hook simulation checks component contracts, not native layout/rendering.
function fixture(file, options = {}) {
  let stateIndex = 0, refIndex = 0;
  const states = [...(options.states || [])], refs = [], effects = [], animations = [];
  const id = `test-${++instance}`;
  const config = {
    os: 'android', width: 375, height: 812, fontScale: 1, focused: true,
    insets: { top: 44, bottom: 34, left: 0, right: 0 },
    settings: { androidLiquidGlass: true, favoriteView: 'grid', favoriteColumns: 3 },
    policy: { effectsEnabled: true, reduceMotion: false },
    ...options,
  };
  const colors = {
    background: '#F6F7FA', card: '#FFFFFF', elevated: '#FFFFFF', text: '#17181C',
    subtext: '#5F636B', border: '#EEEEEE', accent: '#0B6EDB', accentSoft: '#EEEEFF',
    danger: '#D93025', heart: '#D81B60', glassAccent: '#003F86', glassSubtext: '#484852',
    liquidTint: 'rgba(255,255,255,0.76)', glassTint: 'light', chartTrack: '#EEEEEE',
  };
  const hooks = {
    ...React,
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useId: () => id, useMemo: fn => fn(), useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
  };
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    interpolate() { return this.value; }
    stopAnimation() {}
  }
  const animate = (value, settings) => {
    const animation = { ...settings, stopped: false,
      start() { value.setValue(settings.toValue); }, stop() { this.stopped = true; } };
    animations.push(animation);
    return animation;
  };
  const rn = {
    Platform: { OS: config.os, Version: config.api || 33 },
    StyleSheet: { create: value => value, flatten, hairlineWidth: 1, absoluteFill: { position: 'absolute' } },
    useWindowDimensions: () => config, processColor: () => 1,
    Animated: { Value, View: 'AnimatedView', timing: animate, spring: animate },
  };
  ['View', 'Text', 'Modal', 'Pressable', 'FlatList', 'SectionList', 'ScrollView', 'Switch', 'ActivityIndicator']
    .forEach(name => { rn[name] = name; });
  const imports = {
    react: hooks, 'react-native': rn,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => config.insets },
    '@react-navigation/native': { useIsFocused: () => config.focused, useFocusEffect() {} },
    '@expo/vector-icons': { Ionicons: 'Ionicons' }, 'expo-image': { Image: 'Image' },
    'expo-blur': { BlurView: 'BlurView' },
    'expo-glass-effect': { GlassView: 'GlassView', isLiquidGlassAvailable: () => true, isGlassEffectAPIAvailable: () => true },
    '../../modules/liquid-glass': { NativeGlassView: 'NativeGlassView', NativeGlassSource: 'NativeGlassSource', androidLiquidGlassAvailable: true },
    '../context/SettingsContext': { useSettings: () => ({ colors, settings: config.settings, t: key => key, language: 'en', setSetting() {} }) },
    '../context/GlassEffectsContext': { useGlassEffects: () => config.policy },
    '../context/AppContext': { useFavorites: () => ({ favorites: { a: true }, toggleFavorite() {} }), useTrash: () => ({ trash: [{ fileUri: 'a', size: 12 }], refreshTrash() {} }) },
    '../utils/logger': { log() {} }, '../utils/albumHelpers': { formatBytes: value => String(value), ALL_ALBUM_ID: 'all', peekAlbumSummary: () => null },
    '../utils/reviewedStore': { scopeFor: type => type },
    '../utils/thumbCache': {}, '../utils/trashManager': {}, '../utils/sessionManager': {},
    '../utils/chunkedAnalyzer': {}, './ProgressRing': { __esModule: true, default: 'ProgressRing' },
    './pickerButtonStyle': { pickerStyles: {} },
    ...options.imports,
  };
  const load = relative => {
    if (!compiled.has(relative)) compiled.set(relative, babel.transformFileSync(path.join(root, relative), {
      configFile: false, babelrc: false,
      plugins: ['@babel/plugin-transform-modules-commonjs', ['@babel/plugin-transform-react-jsx', { runtime: 'classic' }]],
    }).code);
    const mod = { exports: {} };
    vm.runInNewContext(compiled.get(relative), {
      module: mod, exports: mod.exports, console,
      require(name) {
        if (name in imports) return imports[name];
        if (name === '../utils/tabBarLayout') return load('src/utils/tabBarLayout.js');
        if (/^(\.\/|\.\.\/components\/)(GlassSurface|GlassBackdrop|IconButton|AppBottomSheet|AnalysisProgress|AlbumPicker|TimePicker|GroupSizeStepper|StackedCards|AppDialog)$/.test(name)) {
          return { __esModule: true, default: name.split('/').pop(), showAppAlert() {} };
        }
        throw new Error(`Unmocked import: ${name}`);
      },
    });
    return mod.exports;
  };
  const exports = load(file);
  return {
    config, states, effects, animations, exports,
    render(props = {}) {
      stateIndex = 0; refIndex = 0; effects.length = 0;
      return exports.default(props);
    },
  };
}

function findAll(tree, type, result = []) {
  if (Array.isArray(tree)) tree.forEach(child => findAll(child, type, result));
  else if (React.isValidElement(tree)) {
    if (tree.type === type) result.push(tree);
    findAll(tree.props.children, type, result);
  }
  return result;
}
const one = (tree, type) => {
  const matches = findAll(tree, type);
  assert.equal(matches.length, 1, type);
  return matches[0];
};

test('material policy changes never replace navigation content', () => {
  for (const os of ['android', 'ios']) for (const enabled of [true, false]) for (const reduced of [true, false]) {
    const f = fixture('src/components/GlassSurface.js', { os, policy: { effectsEnabled: enabled, reduceMotion: reduced } });
    const child = React.createElement('control');
    const onLayout = () => {};
    for (const setting of [true, false]) for (const visible of [true, false]) {
      f.config.settings.androidLiquidGlass = setting;
      const tree = f.render({ androidSource: 'source', effectEnabled: visible, children: child, onLayout });
      assert.equal(tree.type, 'View');
      assert.equal(tree.props.children[2], child);
      assert.equal(tree.props.onLayout, onLayout);
      if (os === 'android') assert.equal(one(tree, 'NativeGlassView').props.effectEnabled, enabled && visible && !reduced && setting);
      else assert.equal(findAll(tree, 'GlassView').length, enabled && visible ? 1 : 0);
    }
  }
});

test('missing native views and unavailable iOS APIs use a safe surface', () => {
  const android = fixture('src/components/GlassSurface.js', { imports: {
    '../../modules/liquid-glass': { NativeGlassView: null, androidLiquidGlassAvailable: false },
  } });
  assert.equal(findAll(android.render({ androidSource: 'source' }), 'NativeGlassView').length, 0);
  const ios = fixture('src/components/GlassSurface.js', { os: 'ios', imports: {
    'expo-glass-effect': { GlassView: 'GlassView', isLiquidGlassAvailable: () => true },
  } });
  assert.equal(findAll(ios.render(), 'BlurView').length, 1);
});

test('optional Android adapter guards unsupported runtimes and incomplete binaries', () => {
  for (const os of ['android', 'ios']) for (const api of [32, 33]) {
    let moduleCalls = 0;
    const viewCalls = [];
    const f = fixture('modules/liquid-glass/index.js', { os, api, imports: {
      'expo-modules-core': {
        requireNativeModule(name) {
          moduleCalls++;
          assert.equal(name, 'MediaCleanerLiquidGlass');
          return { isSupported: () => true };
        },
        requireNativeViewManager(name, view) {
          assert.equal(name, 'MediaCleanerLiquidGlass');
          viewCalls.push(view);
          return view;
        },
      },
    } });
    const supported = os === 'android' && api >= 33;
    assert.equal(moduleCalls, supported ? 1 : 0);
    assert.deepEqual(viewCalls, supported ? ['GlassView', 'GlassSource'] : []);
    assert.equal(f.exports.androidLiquidGlassAvailable, supported);
  }

  for (const failure of ['module', 'support-api', 'unsupported', 'support-query', 'view', 'source']) {
    const f = fixture('modules/liquid-glass/index.js', { imports: {
      'expo-modules-core': {
        requireNativeModule() {
          if (failure === 'module') throw new Error('Module absent');
          if (failure === 'support-api') return {};
          return { isSupported() {
            if (failure === 'support-query') throw new Error('Unavailable query');
            return failure !== 'unsupported';
          } };
        },
        requireNativeViewManager(_, view) {
          if (failure === 'view' || (failure === 'source' && view === 'GlassSource')) {
            throw new Error('View absent');
          }
          return view;
        },
      },
    } });
    assert.equal(f.exports.androidLiquidGlassAvailable, false, failure);
    assert.equal(f.exports.NativeGlassView, null, failure);
    assert.equal(f.exports.NativeGlassSource, null, failure);
  }
});

test('backdrop fallback preserves scene wrappers without native-only props', () => {
  for (const available of [true, false]) {
    const f = fixture('src/components/GlassBackdrop.js', { imports: {
      '../../modules/liquid-glass': {
        NativeGlassSource: available ? 'NativeGlassSource' : null,
        androidLiquidGlassAvailable: available,
      },
    } });
    const scene = React.createElement('scene');
    const tree = f.render({
      sourceKey: 'test-source', style: { backgroundColor: '#FFFFFF' },
      contentStyle: { paddingTop: 12 }, children: scene,
    });
    assert.equal(tree.type, available ? 'NativeGlassSource' : 'View');
    assert.equal(tree.props.collapsable, false);
    assert.equal(flatten(tree.props.style).flex, 1);
    assert.equal('sourceKey' in tree.props, available);
    assert.equal(tree.props.children.type, 'View');
    assert.equal(flatten(tree.props.children.props.style).paddingTop, 12);
    assert.equal(tree.props.children.props.children, scene);
  }
});

test('picker headers use unique sibling sources and measured list clearance', () => {
  const keys = new Set();
  for (const size of [[320, 568, 1], [375, 812, 3], [812, 375, 2], [1024, 768, 1]]) {
    const f = fixture('src/components/AppBottomSheet.js', {
      width: size[0], height: size[1], fontScale: size[2],
      insets: { top: 24, bottom: 34, left: 44, right: 44 },
    });
    let closed = 0;
    const props = { visible: true, glassHeader: true, title: 'Choose album', onClose: () => closed++, renderContent: props => React.createElement('FlatList', props) };
    let tree = f.render(props);
    const surface = one(tree, 'GlassSurface'), source = one(tree, 'GlassBackdrop');
    assert.equal(source.props.sourceKey, surface.props.androidSource);
    assert.equal(findAll(source, 'GlassSurface').length, 0);
    assert.ok(!keys.has(source.props.sourceKey)); keys.add(source.props.sourceKey);
    assert.ok(findAll(tree, 'View').some(view => view.props.children?.includes?.(surface) && view.props.children.includes(source)));
    const sheetStyle = flatten(findAll(tree, 'Pressable')[1].props.style);
    assert.equal(sheetStyle.paddingLeft, 60); assert.equal(sheetStyle.paddingRight, 60);
    assert.ok(sheetStyle.maxHeight + 24 <= size[1]);
    const body = findAll(tree, 'View').find(view => typeof view.props.style?.height === 'number');
    assert.ok(body.props.style.height + sheetStyle.paddingBottom + 8 <= sheetStyle.maxHeight);
    assert.equal(findAll(tree, 'Pressable')[0].props.accessible, false);
    assert.equal(findAll(tree, 'Pressable')[1].props.accessible, false);
    surface.props.onLayout({ nativeEvent: { layout: { height: 144 } } });
    tree = f.render(props);
    assert.equal(one(tree, 'FlatList').props.contentContainerStyle.paddingTop, 144);
    assert.equal(one(tree, 'FlatList').props.scrollIndicatorInsets.top, 144);
    assert.equal(one(tree, 'GlassSurface').props.androidSource, surface.props.androidSource);
    one(tree, 'Modal').props.onRequestClose();
    one(tree, 'IconButton').props.onPress();
    findAll(tree, 'Pressable')[0].props.onPress();
    assert.equal(closed, 3);
    assert.equal(one(f.render({ ...props, visible: false }), 'GlassSurface').props.effectEnabled, false);
    f.config.policy.reduceMotion = true;
    assert.equal(one(f.render(props), 'Modal').props.animationType, 'none');
    const plain = f.render({ title: 'Short settings', visible: true, children: React.createElement('settings') });
    assert.equal(findAll(plain, 'GlassSurface').length, 0);
    one(plain, 'settings');
  }
});

test('album and date selections preserve callbacks on Android and iOS', () => {
  for (const os of ['android', 'ios']) {
    const album = { id: 'a', title: 'Camera', assetCount: 12 };
    const selected = [];
    const a = fixture('src/components/AlbumPicker.js', { os });
    const props = { albums: [album], selected: 'a', onSelect: value => selected.push(value) };
    findAll(a.render(props), 'Pressable')[0].props.onPress();
    const tree = a.render(props);
    const sheet = one(tree, os === 'android' ? 'AppBottomSheet' : 'Modal');
    assert.equal(sheet.props.visible, true);
    const list = os === 'android' ? sheet.props.renderContent({}) : one(sheet, 'FlatList');
    list.props.renderItem({ item: album }).props.onPress();
    assert.equal(selected[0], album);
    assert.equal(one(a.render(props), os === 'android' ? 'AppBottomSheet' : 'Modal').props.visible, false);
    if (os === 'android') assert.equal(sheet.props.glassHeader, true);

    const date = fixture('src/components/TimePicker.js', { os });
    const year = { year: 2025, count: 10, months: [[5, 10]] };
    let picked;
    const dateProps = { years: [year], value: null, onSelect: value => { picked = value; } };
    const getList = () => {
      const tree = date.render(dateProps);
      return os === 'android' ? one(tree, 'AppBottomSheet').props.renderContent({}) : one(tree, 'SectionList');
    };
    getList().props.ListHeaderComponent.props.onPress(); assert.equal(picked, null);
    findAll(getList().props.renderItem({ item: year }), 'Pressable')[0].props.onPress();
    assert.equal(picked.start, new Date(2025, 0, 1).getTime()); assert.equal(picked.month, null);
    findAll(getList().props.renderItem({ item: year }), 'Pressable')[1].props.onPress();
    findAll(getList().props.renderItem({ item: year }), 'Pressable')[2].props.onPress();
    assert.equal(picked.start, new Date(2025, 5, 1).getTime());
    assert.equal(picked.end, new Date(2025, 6, 1).getTime());
  }
});

test('Favorites keeps one fixed title, a scrollable toolbar and measured list inset', () => {
  const f = fixture('src/screens/FavoritesScreen.js', { states: [56, [{ id: 'a' }], {}, false] });
  const props = { navigation: { goBack() {} } };
  let tree = f.render(props);
  const glass = one(tree, 'GlassSurface'), source = one(tree, 'GlassBackdrop');
  assert.equal(glass.props.androidSource, source.props.sourceKey);
  assert.equal(findAll(source, 'GlassSurface').length, 0);
  assert.equal(findAll(glass, 'Pressable').length, 0);
  assert.equal(findAll(one(tree, 'FlatList').props.ListHeaderComponent, 'Pressable').length, 1);
  glass.props.onLayout({ nativeEvent: { layout: { height: 126 } } });
  tree = f.render(props); assert.equal(one(tree, 'FlatList').props.contentContainerStyle.paddingTop, 138);
  f.config.focused = false;
  assert.equal(one(f.render(props), 'GlassSurface').props.effectEnabled, false);
});

test('recycle actions and analysis use safe-content parents and measured bottom clearance', () => {
  const r = fixture('src/screens/RecycleBinScreen.js', { states: [72, { a: true }, false, {}], fontScale: 2 });
  const props = { navigation: { goBack() {} } };
  let tree = r.render(props);
  const glass = one(tree, 'GlassSurface'), source = one(tree, 'GlassBackdrop');
  assert.equal(glass.props.androidSource, source.props.sourceKey);
  assert.equal(flatten(glass.props.style).left, 0);
  assert.equal(one(tree, 'SafeAreaView').props.children.type, 'View');
  glass.props.onLayout({ nativeEvent: { layout: { height: 160 } } });
  tree = r.render(props);
  assert.equal(one(tree, 'FlatList').props.contentContainerStyle.paddingBottom, 160 + 34 + 16);
  const row = one(one(tree, 'GlassSurface'), 'View');
  assert.equal(flatten(row.props.style).flexDirection, 'column');
  const buttonStyle = flatten(findAll(row, 'Pressable')[0].props.style({ pressed: false }));
  assert.equal(buttonStyle.flexBasis, 'auto');
  assert.ok(buttonStyle.minHeight >= 48);
  r.states[2] = true;
  assert.ok(findAll(one(r.render(props), 'GlassSurface'), 'Pressable').every(button => button.props.disabled));

  const home = fixture('src/screens/AlbumSelectScreen.js');
  const homeTree = home.render(props);
  assert.equal(one(homeTree, 'SafeAreaView').props.children.type, 'View');
  assert.equal(one(homeTree, 'GlassBackdrop').props.sourceKey, one(homeTree, 'AnalysisProgress').props.androidSource);
  assert.equal(findAll(one(homeTree, 'GlassBackdrop'), 'AnalysisProgress').length, 0);
});

test('analysis label stays bounded while progress and cancellation work', () => {
  for (const fontScale of [1, 2, 3]) {
    const f = fixture('src/components/AnalysisProgress.js', { fontScale, height: 568 });
    let cancelled = 0;
    assert.equal(f.render({ state: { running: true, total: 0 } }), null);
    const tree = f.render({ state: { running: true, total: 100, done: 140 }, androidSource: 'home', onCancel: () => cancelled++ });
    const scroll = one(tree, 'ScrollView');
    assert.ok(flatten(scroll.props.style).maxHeight <= 112);
    one(tree, 'Pressable').props.onPress(); assert.equal(cancelled, 1);
    assert.ok(findAll(tree, 'View').some(view => flatten(view.props.style).width === '100%'));
  }
});

test('app switches respect reduced motion without changing their value or callback', () => {
  for (const os of ['android', 'ios']) for (const reduced of [false, true]) {
    const f = fixture('src/components/AppSwitch.js', { os, policy: { reduceMotion: reduced, effectsEnabled: true } });
    let changed;
    const tree = f.render({ value: true, onValueChange: value => { changed = value; }, label: 'Glass' });
    f.effects.forEach(effect => effect());
    if (os === 'android') {
      assert.equal(f.animations.length, reduced ? 0 : 1);
      one(tree, 'Pressable').props.onPress(); assert.equal(changed, false);
      assert.equal(tree.props.accessibilityState.checked, true);
    } else { one(tree, 'Switch'); assert.equal(f.animations.length, 0); }
  }
});
