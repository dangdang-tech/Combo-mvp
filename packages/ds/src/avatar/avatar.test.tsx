import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, initialsOf } from './avatar';

describe('initialsOf', () => {
  it('中文名取第一个字', () => {
    expect(initialsOf('张伟')).toBe('张');
    expect(initialsOf('王小明')).toBe('王');
  });

  it('英文多词名取首尾词首字母并大写', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada middle lovelace')).toBe('AL');
  });

  it('英文单词名只取首字母并大写', () => {
    expect(initialsOf('benzema')).toBe('B');
  });

  it('首尾空白被忽略，空白字符串返回空串', () => {
    expect(initialsOf('  张伟  ')).toBe('张');
    expect(initialsOf('   ')).toBe('');
    expect(initialsOf('')).toBe('');
  });
});

describe('Avatar', () => {
  it('纯 JSON props（只有 name 字符串）即可渲染出首字母回退', () => {
    const props = { name: '张伟' };
    render(<Avatar {...props} />);
    const root = screen.getByRole('img', { name: '张伟' });
    expect(root).toHaveClass('cb-avatar', 'cb-avatar--md');
    expect(root).toHaveTextContent('张');
  });

  it('回退底色按 name hash 稳定挑选：同名多次渲染类名一致', () => {
    const first = render(<Avatar name="Ada Lovelace" />);
    const tone = [...(first.container.querySelector('.cb-avatar')?.classList ?? [])].find((cls) =>
      cls.startsWith('cb-avatar--tone-'),
    );
    expect(tone).toBeDefined();
    first.unmount();
    const second = render(<Avatar name="Ada Lovelace" />);
    expect(second.container.querySelector('.cb-avatar')).toHaveClass(tone ?? '');
  });

  it('有 src 时渲染图片，不渲染首字母', () => {
    const props = { name: '张伟', src: 'https://example.com/a.png' };
    const { container } = render(<Avatar {...props} />);
    const img = container.querySelector<HTMLImageElement>('.cb-avatar-img');
    expect(img).not.toBeNull();
    expect(img?.src).toBe('https://example.com/a.png');
    expect(container.querySelector('.cb-avatar-initials')).toBeNull();
  });

  it('图片加载失败后回退到首字母', () => {
    const { container } = render(
      <Avatar name="Ada Lovelace" src="https://example.com/broken.png" />,
    );
    const img = container.querySelector('.cb-avatar-img');
    expect(img).not.toBeNull();
    if (img !== null) {
      fireEvent.error(img);
    }
    expect(container.querySelector('.cb-avatar-img')).toBeNull();
    expect(container.querySelector('.cb-avatar-initials')).toHaveTextContent('AL');
  });

  it('size 联合枚举映射到对应类名', () => {
    const { container } = render(
      <div>
        <Avatar name="甲" size="sm" />
        <Avatar name="乙" size="lg" />
      </div>,
    );
    expect(container.querySelector('.cb-avatar--sm')).not.toBeNull();
    expect(container.querySelector('.cb-avatar--lg')).not.toBeNull();
  });
});
