import { scrollTargetFor } from './settings-page.js';

describe('scrollTargetFor', () => {
  const box = { scrollTop: 300, scrollHeight: 2000, clientHeight: 700 };
  const key = (name: string, shiftKey = false) => ({ key: name, shiftKey });

  it('takes End to the end and Home to the top', () => {
    expect(scrollTargetFor(key('End'), box)).toBe(1300);
    expect(scrollTargetFor(key('Home'), box)).toBe(0);
  });

  it('moves a page less one step with Page Down, Page Up and Space, within the ends', () => {
    expect(scrollTargetFor(key('PageDown'), box)).toBe(960);
    expect(scrollTargetFor(key('PageUp'), box)).toBe(0);
    expect(scrollTargetFor(key(' '), box)).toBe(960);
    expect(scrollTargetFor(key(' ', true), box)).toBe(0);
    expect(scrollTargetFor(key('PageDown'), { ...box, scrollTop: 1200 })).toBe(
      1300,
    );
  });

  it('steps with the arrows and leaves any other key alone', () => {
    expect(scrollTargetFor(key('ArrowDown'), box)).toBe(340);
    expect(scrollTargetFor(key('ArrowUp'), box)).toBe(260);
    expect(scrollTargetFor(key('a'), box)).toBeNull();
    expect(scrollTargetFor(key('Tab'), box)).toBeNull();
  });
});
