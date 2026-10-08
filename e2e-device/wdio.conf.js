const env = process.env;
const PLATFORM = env.PLATFORM || 'desktop';
const TARGET_URL = env.TARGET_URL || 'https://906.connect-d5y.pages.dev/demo';
const OUT_DIR = env.OUT_DIR || 'out';

function iosCapabilities() {
  const caps = {
    platformName: 'iOS',
    browserName: 'Safari',
    'wdio:enforceWebDriverClassic': true,
    'appium:automationName': 'XCUITest',
    'appium:deviceName': env.DEVICE_NAME,
    'appium:platformVersion': env.IOS_VERSION,
    'appium:safariInitialUrl': TARGET_URL,
    'appium:newCommandTimeout': 300,
    'appium:noReset': true,
    'appium:wdaLaunchTimeout': 300000,
    'appium:wdaConnectionTimeout': 300000,
    'appium:wdaStartupRetries': 2,
    'appium:wdaStartupRetryInterval': 20000,
    'appium:showXcodeLog': false,
    'appium:webviewConnectTimeout': 60000,
  };
  if (env.UDID) caps['appium:udid'] = env.UDID;
  if (env.WDA_DERIVED_DATA) caps['appium:derivedDataPath'] = env.WDA_DERIVED_DATA;
  if (env.WDA_PREBUILT === 'true') caps['appium:usePrebuiltWDA'] = true;
  return caps;
}

function androidCapabilities() {
  return {
    platformName: 'Android',
    browserName: 'Chrome',
    'wdio:enforceWebDriverClassic': true,
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': 'Android Emulator',
    'appium:newCommandTimeout': 300,
    'appium:chromedriverAutodownload': true,
    'appium:adbExecTimeout': 120000,
    'appium:uiautomator2ServerLaunchTimeout': 180000,
    'appium:chromeOptions': { args: ['--no-first-run', '--disable-fre', '--no-default-browser-check'] },
  };
}

function desktopCapabilities() {
  const options = {
    args: ['--headless=new', '--no-sandbox', '--window-size=412,915'],
    mobileEmulation: {
      deviceMetrics: { width: 412, height: 915, pixelRatio: 2.625, touch: true, mobile: true },
    },
  };
  if (env.CHROME_BIN) options.binary = env.CHROME_BIN;
  return { browserName: 'chrome', 'goog:chromeOptions': options };
}

const capabilities = {
  ios: iosCapabilities,
  android: androidCapabilities,
  desktop: desktopCapabilities,
}[PLATFORM]();

const remote = PLATFORM === 'desktop' ? {} : { hostname: 'localhost', port: 4723, path: '/' };

export const config = {
  ...remote,
  runner: 'local',
  specs: ['./specs/playback.e2e.js'],
  maxInstances: 1,
  capabilities: [capabilities],
  logLevel: 'warn',
  outputDir: `${OUT_DIR}/wdio-logs`,
  waitforTimeout: 20000,
  connectionRetryTimeout: 300000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 12 * 60 * 1000,
    bail: false,
  },
};
