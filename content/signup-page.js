// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE') {
    handleCommand(message).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      // Retryable errors: don't reportError (which marks step as failed)
      const retryable = err.message === 'PHONE_PAGE_DETECTED' || err.message === 'ERROR_PAGE_DETECTED';
      if (!retryable) {
        reportError(message.step, err.message);
      }
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_login(message.payload);
        case 8: return await step8_clickContinue();
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
  }
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  log('Step 2: Found Register button, waiting before click...');
  await sleep(2500);
  reportComplete(2);
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  log(`Step 3: Filling email: ${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  await slowType(emailInput, email, 60);
  log('Step 3: Email filled');
  await sleep(800);

  // Check if password field is on the same page
  let passwordInput = document.querySelector('input[type="password"]');

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      simulateClick(submitBtn);
      log('Step 3: Submitted email, waiting for password field...');
      await sleep(2000);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('Could not find password input after submitting email. URL: ' + location.href);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 3 requires a generated password.');
  await slowType(passwordInput, payload.password, 80);
  log('Step 3: Password filled');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  log('Step 3: Form filled, pausing to show result...');
  await sleep(2500);
  reportComplete(3, { email });

  // Submit the form (page will navigate away after this)
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log('Step 3: Form submitted');
  }
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      log(`Step ${step}: Code filled in single-digit inputs, pausing...`);
      await sleep(2500);
      reportComplete(step);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  await slowType(codeInput, code, 150);
  log(`Step ${step}: Code filled, pausing to show result...`);

  // Report complete BEFORE submit (page may navigate away)
  await sleep(2500);
  reportComplete(step);

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function step6_login(payload) {
  const { email, password, phase } = payload;

  // Phase 2: password page (after page navigation from email submit)
  if (phase === 'password') {
    log('Step 6: On password page, looking for password field...');
    let passwordInput = null;
    try {
      passwordInput = await waitForElement('input[type="password"]', 15000);
    } catch {
      throw new Error('Could not find password input on password page. URL: ' + location.href);
    }

    log('Step 6: Password field found, filling password...');
    await slowType(passwordInput, password, 80);

    await sleep(500);
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    log('Step 6: Password filled, pausing to show result...');
    await sleep(2500);
    reportComplete(6, { needsOTP: true });

    if (submitBtn) {
      simulateClick(submitBtn);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }
    return;
  }

  // Phase 1 (default): email page
  if (!email) throw new Error('No email provided for login.');
  log(`Step 6: Logging in with ${email}...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  await slowType(emailInput, email, 60);
  log('Step 6: Email filled');
  await sleep(800);

  // Submit email
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  await sleep(2000);

  // Check if password field appeared on the same page (SPA, no navigation)
  const passwordInput = document.querySelector('input[type="password"]');
  if (passwordInput) {
    log('Step 6: Password field found on same page, filling password...');
    await slowType(passwordInput, password, 80);

    await sleep(500);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    log('Step 6: Credentials filled, pausing to show result...');
    await sleep(2500);
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }
    return;
  }

  // No password field — page likely navigating to a separate password page
  // Do NOT call reportComplete here. Background will detect the navigation
  // and send a phase 2 command to the new content script on the password page.
  log('Step 6: No password field on this page. Email submitted, waiting for page navigation...');
}

// ============================================================
// Step 8: Click "继续" on OAuth consent page
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Clicking it triggers redirect to localhost URL.

async function step8_clickContinue() {
  log('Step 8: Checking page state...');

  // Check if we hit the "电话号码是必填项" page
  const phonePageDetected = document.querySelector('input[autocomplete="tel"], input[type="tel"]')
    || document.querySelector('form[action*="add-phone"]');
  const phoneHeading = document.querySelector('h1');
  const isPhonePage = phonePageDetected || (phoneHeading && /电话号码|phone\s*number/i.test(phoneHeading.textContent));

  if (isPhonePage) {
    log('Step 8: Detected phone number required page! Will retry login...', 'warn');
    throw new Error('PHONE_PAGE_DETECTED');
  }

  // Check if we hit the "糟糕，出错了！" error page (invalid_state etc.)
  const errorHeading = document.querySelector('h1');
  const isErrorPage = errorHeading && /糟糕|出错|error|something went wrong/i.test(errorHeading.textContent);
  const hasInvalidState = document.body.textContent.includes('invalid_state');
  if (isErrorPage || hasInvalidState) {
    log('Step 8: Detected error page (invalid_state)! Will retry login...', 'warn');
    throw new Error('ERROR_PAGE_DETECTED');
  }

  // Wait for the consent page to be ready
  // Look for the submit button with text "继续" or data-dd-action-name="Continue"
  let continueBtn = null;
  try {
    continueBtn = await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    // Double-check: maybe phone page appeared after waiting
    const latePhoneCheck = document.querySelector('form[action*="add-phone"]')
      || document.querySelector('input[type="tel"]');
    if (latePhoneCheck) {
      log('Step 8: Phone number page appeared while waiting! Will retry login...', 'warn');
      throw new Error('PHONE_PAGE_DETECTED');
    }
    // Double-check: maybe error page appeared after waiting
    const lateErrorCheck = document.querySelector('h1');
    const lateIsError = (lateErrorCheck && /糟糕|出错|error|something went wrong/i.test(lateErrorCheck.textContent))
      || document.body.textContent.includes('invalid_state');
    if (lateIsError) {
      log('Step 8: Error page appeared while waiting! Will retry login...', 'warn');
      throw new Error('ERROR_PAGE_DETECTED');
    }
    try {
      continueBtn = await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
    }
  }

  // Try clicking "继续" up to 3 times with different methods
  for (let clickAttempt = 1; clickAttempt <= 3; clickAttempt++) {
    log(`Step 8: Clicking "继续" (attempt ${clickAttempt})...`);

    // Method 1: native .click()
    continueBtn.click();
    log('Step 8: Clicked via .click()');

    await sleep(500);

    // Method 2: form.requestSubmit()
    const form = continueBtn.closest('form');
    if (form) {
      try {
        form.requestSubmit(continueBtn);
        log('Step 8: Triggered form.requestSubmit()');
      } catch { /* some pages don't support requestSubmit */ }
    }

    // Method 3: simulateClick (dispatchEvent) as fallback
    if (clickAttempt >= 2) {
      simulateClick(continueBtn);
      log('Step 8: Triggered simulateClick()');
    }

    log('Step 8: Waiting to check for redirect or error...');
    await sleep(3000);

    // Check for error pages
    const postClickHeading = document.querySelector('h1');
    const postClickIsError = postClickHeading && /糟糕|出错|error|something went wrong/i.test(postClickHeading.textContent);
    const postClickInvalidState = document.body.textContent.includes('invalid_state')
      || document.body.textContent.includes('Invalid workspace');
    if (postClickIsError || postClickInvalidState) {
      log('Step 8: Error page appeared after clicking "继续"! Will retry login...', 'warn');
      throw new Error('ERROR_PAGE_DETECTED');
    }

    // Check if the button is still on the page (meaning click didn't trigger navigation)
    const stillHere = document.querySelector(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107'
    );
    if (!stillHere) {
      // Page navigated away — redirect should be happening
      log('Step 8: Page navigated, waiting for localhost redirect...');
      break;
    }

    if (clickAttempt < 3) {
      log(`Step 8: Button still visible after click, retrying...`, 'warn');
      // Re-find button in case DOM changed
      continueBtn = stillHere;
    } else {
      log('Step 8: Button still visible after 3 click attempts, redirect may be slow...', 'warn');
    }
  }

  log('Step 8: Waiting for localhost redirect... (background will capture URL)');

  // Don't reportComplete — background handles it via webNavigation listener
}

// ============================================================
// Step 5: Fill Name & Birthday
// ============================================================

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}, Birthday: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField with 3 spinbutton divs (year/month/day)
  //   + <input type="hidden" name="birthday" value="2026-04-05">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  await slowType(nameInput, fullName, 80);
  log(`Step 5: Name filled: ${fullName}`);
  await sleep(800);

  // --- Birthday (React Aria DateField with spinbutton segments) ---
  // The date field has three contenteditable divs with role="spinbutton"
  // and data-type="year", data-type="month", data-type="day"
  // There's also a hidden input[name="birthday"] that stores the actual value

  const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
  const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
  const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');

  if (yearSpinner && monthSpinner && daySpinner) {
    log('Step 5: Found React Aria DateField spinbuttons');

    // Helper to set a spinbutton value via focus + keyboard input
    async function setSpinButton(el, value) {
      el.focus();
      await sleep(100);

      // Select all existing text
      document.execCommand('selectAll', false, null);
      await sleep(50);

      // Type the new value digit by digit
      const valueStr = String(value);
      for (const char of valueStr) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
        // Also use InputEvent for React Aria
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
        await sleep(50);
      }

      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
      el.blur();
      await sleep(100);
    }

    await setSpinButton(yearSpinner, year);
    log(`Step 5: Year set: ${year}`);

    await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
    log(`Step 5: Month set: ${month}`);

    await setSpinButton(daySpinner, String(day).padStart(2, '0'));
    log(`Step 5: Day set: ${day}`);

    // Also update the hidden input directly as a safety measure
    const hiddenBirthday = document.querySelector('input[type="hidden"][name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set: ${dateStr}`);
    }
  } else {
    // Fallback: try setting hidden input directly
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Birthday set via hidden input: ${dateStr}`);
    } else {
      log('Step 5: WARNING - Could not find birthday fields. May need to adjust selectors.', 'warn');
    }
  }

  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  // Report complete BEFORE submit (page navigates to add-phone after this)
  log('Step 5: Name & birthday filled, pausing to show result...');
  await sleep(2500);
  reportComplete(5);

  if (completeBtn) {
    simulateClick(completeBtn);
    log('Step 5: Clicked "完成帐户创建"');
  }
}
