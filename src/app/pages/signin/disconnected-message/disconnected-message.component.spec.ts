import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import {
  DisconnectedMessageComponent,
} from 'app/pages/signin/disconnected-message/disconnected-message.component';

describe('DisconnectedMessageComponent', () => {
  let spectator: Spectator<DisconnectedMessageComponent>;
  const createComponent = createComponentFactory({
    component: DisconnectedMessageComponent,
  });

  beforeEach(() => {
    spectator = createComponent();
  });

  it('shows "Connecting to HarborNAS" message', () => {
    expect(spectator.fixture.nativeElement).toHaveText('Connecting to HarborNAS');
    expect(spectator.fixture.nativeElement).toHaveText('Make sure the HarborNAS system is powered on and connected to the network.');
  });
});
