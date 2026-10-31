import { iscsiRoutes } from 'app/pages/sharing/iscsi/iscsi.routes';

describe('iSCSI routes after target management removal', () => {
  const sections = iscsiRoutes[0].children ?? [];

  it('opens extents by default and redirects legacy target bookmarks to the available settings', () => {
    expect(sections.find((route) => route.path === '')).toEqual(expect.objectContaining({
      redirectTo: 'extents', pathMatch: 'full',
    }));
    expect(sections.find((route) => route.path === 'targets')).toEqual(expect.objectContaining({
      redirectTo: 'extents', pathMatch: 'full',
    }));
    expect(sections.find((route) => route.path === 'targets')?.component).toBeUndefined();
  });

  it('retains extents, initiators, portals, access and fibre-channel configuration', () => {
    expect(sections.map((route) => route.path)).toEqual(expect.arrayContaining([
      'extents', 'initiators', 'portals', 'authorized-access', 'fibre-channel-ports',
    ]));
  });
});
