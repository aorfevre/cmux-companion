const notificationSuite = Cypress.expose('settings') ? describe : describe.skip;
notificationSuite('Notification settings with a disposable service and fake push provider', () => {
  it('persists browser notices, enrolls explicitly and revokes the device without changing update policy', () => {
    cy.viewport(390, 844);
    cy.visit('/settings#notifications', { onBeforeLoad(win) {
      let current: { toJSON: () => unknown; unsubscribe: () => Promise<boolean> } | null = null;
      const permission = { permission: 'default', requestPermission: async () => { permission.permission = 'granted'; return 'granted'; } };
      const registration = { pushManager: { getSubscription: async () => current, subscribe: async () => {
        const key = await win.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const raw = new Uint8Array(await win.crypto.subtle.exportKey('raw', key.publicKey));
        const encode = (bytes: Uint8Array) => win.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        current = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/disposable-test', keys: { p256dh: encode(raw), auth: encode(new Uint8Array(16).fill(1)) } }), unsubscribe: async () => { current = null; return true; } }; return current;
      } } };
      Object.defineProperty(win, 'Notification', { configurable: true, value: permission });
      Object.defineProperty(win, 'PushManager', { configurable: true, value: function() {} });
      Object.defineProperty(win.navigator, 'serviceWorker', { configurable: true, value: { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration } });
    } });
    cy.task<string>('settingsPairing', null, { log: false }).then(token => {
      cy.findByLabelText('Pairing code').type(token, { log: false });
      cy.findByRole('button', { name: 'Pair this device' }).click();
    });
    cy.findByRole('heading', { name: 'Notifications' }).should('be.visible');
    cy.findByRole('switch', { name: /In-app update notices/ }).should('be.checked').click();
    cy.window().its('localStorage').invoke('getItem', 'cmux-companion-update-notices').should('equal', 'false');
    cy.findByRole('button', { name: 'Show test in-app notice' }).click();
    cy.findByRole('button', { name: 'Dismiss test notice' }).click();
    cy.findByRole('button', { name: 'Enable background notifications' }).should('be.enabled').click();
    cy.contains('Background notifications registered.').should('be.visible');
    cy.findByRole('switch', { name: 'Hide project and goal names' }).should('be.checked');
    cy.findByRole('button', { name: 'Send test notification' }).click();
    cy.contains('Accepted by push service', { timeout: 10000 }).should('be.visible');
    cy.screenshot('notification-settings-mobile');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
    cy.findByRole('button', { name: 'Disable background notifications on this device' }).click();
    cy.contains('This device’s background notifications are disabled.').should('be.visible');
    cy.findByRole('button', { name: /^Updates$/ }).click();
    cy.findByRole('switch', { name: 'Automatic installation' }).should('not.be.checked');
    cy.findByRole('button', { name: /^Notifications$/ }).click();
    cy.findByRole('switch', { name: /In-app update notices/ }).should('not.be.checked');
    cy.viewport(1200, 900); cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(1200)); cy.screenshot('notification-settings-desktop');
  });
});
