const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const results = [];
const output = path.join(root, 'audit', 'verification');
fs.mkdirSync(output, { recursive: true });
const url = 'file://' + path.join(root, 'public', 'index.html');
const key = 'idente-mag-studio-v4';
let browser;
async function fresh(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.issue-item').first().waitFor();
  return { context, page, errors };
}
async function quality(page) {
  await page.locator('#qualityBtn').click();
  await page.locator('#qualityDialog.open').waitFor({ timeout: 20000 });
  return page.locator('#qualityDialog').innerText();
}
async function closeQuality(page) { await page.locator('#qualityClose').click(); }
async function downloadProject(page) {
  await page.locator('#projectMenu summary').click();
  const pending = page.waitForEvent('download');
  await page.locator('#saveBtn').click();
  const download = await pending;
  const file = await download.path();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function upload(page, project) {
  await page.locator('#projectLoader').setInputFiles({ name: 'projet.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
}
async function scenario(name, action, options) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return;
  const { context, page, errors } = await fresh(options);
  const started = Date.now();
  try {
    await action(page, context);
    assert.deepEqual(errors, [], 'Aucune erreur JavaScript inattendue');
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log('OK  ' + name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message, ms: Date.now() - started });
    console.log('FAIL ' + name + ': ' + e.message);
    await page.screenshot({ path: path.join(output, 'echec-' + results.length + '.png') }).catch(() => {});
  } finally { await context.close(); }
}
(async () => {
  browser = await chromium.launch({ headless: process.env.HEADLESS === '1', slowMo: 20, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  await scenario('Démonstration : 12 rubriques, composition et PDF', async page => {
    assert.equal(await page.locator('.issue-item').count(), 12);
    assert.equal(await page.locator('#pageNumber').innerText(), '01 / 12');
    assert.match(await quality(page), /0 blocage/);
    await closeQuality(page);
    await page.screenshot({ path: path.join(output, 'bureau.png') });
    await page.pdf({ path: path.join(output, 'magazine-temoin.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  });
  await scenario('Import refusé sans altération du projet actif', async page => {
    const before = await downloadProject(page);
    await upload(page, { meta: {}, pages: [{ type: 'agenda', events: 'INVALIDE' }] });
    assert.match(await page.locator('#toast').innerText(), /Import refusé/);
    assert.deepEqual(await downloadProject(page), before);
    assert.equal(await page.locator('.issue-item').count(), 12);
  });
  await scenario('Texte : annuler, rétablir, raccourcis et nouvelle branche', async page => {
    const field = page.locator('[data-field="title"]');
    const before = await field.inputValue();
    await field.fill('TITRE MODIFIÉ');
    await page.locator('#undoBtn').click();
    assert.equal(await field.inputValue(), before);
    await page.keyboard.press('Control+Shift+Z');
    assert.equal(await field.inputValue(), 'TITRE MODIFIÉ');
    await page.keyboard.press('Control+z');
    assert.equal(await field.inputValue(), before);
    await field.fill('AUTRE TITRE');
    assert.equal(await page.locator('#redoBtn').isDisabled(), true);
  });
  await scenario('Rubriques : créer, dupliquer, déplacer, supprimer et annuler', async page => {
    await page.locator('#addPage').click();
    await page.locator('#newType').selectOption('article');
    await page.locator('#confirmAdd').click();
    await page.locator('[data-field="title"]').fill('ARTICLE TEST');
    await page.locator('#duplicateBtn').click();
    assert.equal(await page.locator('.issue-item').count(), 14);
    await page.locator('#moveDownBtn').click();
    page.once('dialog', d => d.accept());
    await page.locator('#deleteBtn').click();
    assert.equal(await page.locator('.issue-item').count(), 13);
    await page.locator('#undoBtn').click();
    assert.equal(await page.locator('.issue-item').count(), 14);
    await page.locator('#redoBtn').click();
    assert.equal(await page.locator('.issue-item').count(), 13);
    const exported = await downloadProject(page);
    await upload(page, exported);
    assert.deepEqual(await downloadProject(page), exported);
  });
  for (const [type, index] of [['feature', 5], ['article', 3], ['editorial', 1]]) {
    await scenario('Texte long intégral, aperçu et PDF : ' + type, async page => {
      await page.locator('.issue-item').nth(index).click();
      const marker = 'FIN_' + type.toUpperCase() + '_TEST';
      const originalText = ('Une histoire concrète pour notre communauté. ').repeat(180) + marker;
      await page.locator('[data-field="body"]').fill(originalText);
      const total = Number((await page.locator('#pageNumber').innerText()).split('/')[1].trim());
      assert.ok(total > 12);
      await page.locator('#nextBtn').click();
      assert.match(await page.locator('#preview').innerText(), /SUITE/);
      assert.match(await quality(page), /0 blocage/);
      const text = await page.locator('#printBook').textContent();
      assert.ok(text.includes(marker));
      const fragments = await page.locator('#printBook .sheet[data-source="' + index + '"] .article-body, #printBook .sheet[data-source="' + index + '"] .editorial-text, #printBook .sheet[data-source="' + index + '"] .continued-copy').allTextContents();
      assert.equal(fragments.join(''), originalText, 'Chaque caractère du texte source est conservé dans l’ordre');
      await closeQuality(page);
      const pdf = path.join(output, type + '-long.pdf');
      await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
      const extracted = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });
      assert.ok(extracted.includes(marker), 'La fin du texte est présente dans le PDF');
      await page.screenshot({ path: path.join(output, type + '-suite.png') });
    });
  }
  await scenario('Interview longue : trois réponses intégrales', async page => {
    await page.locator('.issue-item').nth(6).click();
    for (let j = 1; j <= 3; j++) await page.locator('[data-field="answer' + j + '"]').fill(('Réponse approfondie et témoignage fidèle. ').repeat(90) + 'FIN_REPONSE_' + j);
    assert.match(await quality(page), /0 blocage/);
    const text = await page.locator('#printBook').textContent();
    for (let j = 1; j <= 3; j++) assert.ok(text.includes('FIN_REPONSE_' + j));
  });
  await scenario('Liste d’agenda : continuation, suppression et undo', async page => {
    await page.locator('.issue-item').nth(11).click();
    for (let j = 0; j < 9; j++) await page.locator('[data-add="events"]').click();
    await page.locator('[data-list="events"][data-row="11"][data-prop="activity"]').fill('DERNIER RENDEZ-VOUS');
    assert.match(await quality(page), /0 blocage/);
    assert.ok((await page.locator('#printBook').textContent()).includes('DERNIER RENDEZ-VOUS'));
    await closeQuality(page);
    await page.locator('[data-remove="events"][data-index="11"]').click();
    assert.equal(await page.locator('[data-list="events"][data-prop="activity"]').count(), 11);
    await page.locator('#undoBtn').click();
    assert.equal(await page.locator('[data-list="events"][data-prop="activity"]').count(), 12);
  });
  await scenario('Sommaire long : plusieurs pages et numéros physiques', async page => {
    const original = await downloadProject(page);
    const toc = original.pages.find(p => p.type === 'toc');
    const article = original.pages.find(p => p.type === 'article');
    const project = { ...original, pages: [original.pages[0], toc, ...Array.from({ length: 35 }, (_, i) => ({ ...article, id: 'article-' + i, title: 'Histoire de la communauté numéro ' + (i + 1), body: 'Un article court.', translations: {} }))] };
    await upload(page, project);
    await page.locator('.issue-item').nth(1).click();
    assert.match(await quality(page), /0 blocage/);
    const tocPages = await page.locator('#printBook .sheet[data-source="1"]').count();
    assert.ok(tocPages > 1);
    const firstArticlePage = await page.locator('#printBook .sheet[data-source="2"] .page-no').innerText();
    const firstTocNumber = await page.locator('#printBook .toc-page').first().innerText();
    assert.match(firstArticlePage, new RegExp(firstTocNumber));
    assert.equal(await page.locator('#printBook .toc-line').count(), 35);
  });
  await scenario('FR/EN/PT : textes distincts et photos communes', async page => {
    await page.locator('.issue-item').nth(3).click();
    const french = await page.locator('[data-field="title"]').inputValue();
    await page.locator('#languagePicker').selectOption('en');
    await page.locator('[data-field="title"]').fill('OUR COMMUNITY');
    await page.locator('#languagePicker').selectOption('fr');
    assert.equal(await page.locator('[data-field="title"]').inputValue(), french);
    await page.locator('#languagePicker').selectOption('en');
    assert.equal(await page.locator('[data-field="title"]').inputValue(), 'OUR COMMUNITY');
    await page.locator('.issue-item').nth(8).click();
    const image = (await downloadProject(page)).pages[0].image;
    await page.locator('[data-field="images.0"]').fill(image);
    await page.locator('#languagePicker').selectOption('pt');
    assert.equal(await page.locator('[data-field="images.0"]').inputValue(), image);
    await page.locator('#languagePicker').selectOption('fr');
    assert.equal(await page.locator('[data-field="images.0"]').inputValue(), image);
  });
  await scenario('Hors ligne à froid : photos, polices et sauvegarde', async page => {
    await page.locator('.issue-item').nth(3).click();
    const image = await page.locator('#preview .article-image').evaluate(im => im.complete && im.naturalWidth > 0);
    assert.equal(image, true);
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.equal(await page.evaluate(() => document.fonts.check('16px "DM Sans"')), true);
    await page.locator('[data-field="title"]').fill('ÉDITION HORS LIGNE');
    await page.waitForTimeout(600);
    assert.ok((await page.evaluate(k => localStorage.getItem(k), key)).includes('ÉDITION HORS LIGNE'));
    await page.screenshot({ path: path.join(output, 'hors-ligne.png') });
    await page.reload();
    await page.locator('.issue-item').nth(3).click();
    assert.equal(await page.locator('[data-field="title"]').inputValue(), 'ÉDITION HORS LIGNE');
  }, { offline: true });
  await scenario('Responsive : commandes accessibles et panneaux refermables', async page => {
    for (const width of [1280, 1024, 768, 390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, viewport: innerWidth, toolbar: document.querySelector('.toolbar').getBoundingClientRect().right, stageScroll: document.querySelector('#stage').scrollWidth, stageWidth: document.querySelector('#stage').clientWidth }));
      assert.equal(layout.doc, width, 'Pas de débordement global à ' + width);
      assert.ok(layout.toolbar <= width, 'Barre d’outils dans la fenêtre à ' + width);
      assert.ok(layout.stageScroll <= layout.stageWidth + 2, 'Aperçu ajusté à ' + width);
      if (width <= 1100) {
        await page.locator('#editToggle').click();
        await page.locator('#editorClose').click();
        await page.locator('#menuToggle').click();
        await page.locator('#sidebarClose').click();
        await page.locator('#projectMenu summary').click();
        assert.equal(await page.locator('#saveBtn').isVisible(), true);
        assert.equal(await page.locator('#loadBtn').isVisible(), true);
        await page.locator('#projectMenu summary').click();
      }
      await page.screenshot({ path: path.join(output, 'responsive-' + width + '.png') });
    }
  });
  await scenario('Titre excessif : export bloqué plutôt que contenu coupé', async page => {
    await page.locator('[data-field="title"]').fill(('Un très grand titre qui ne tient pas. ').repeat(40));
    assert.match(await quality(page), /[1-9]\d* blocage/);
    assert.equal(await page.locator('#qualityExport').isDisabled(), true);
  });
  await scenario('Complément : paramètres, image et import avec undo/redo', async page => {
    await page.locator('.general-settings summary').click();
    const name = page.locator('[data-field="name"][data-scope="meta"]');
    const beforeName = await name.inputValue();
    await name.fill('MAGAZINE TEST');
    await page.locator('#undoBtn').click();
    assert.equal(await name.inputValue(), beforeName);
    assert.equal(await page.locator('.general-settings').getAttribute('open'), '');
    await page.locator('#redoBtn').click();
    assert.equal(await name.inputValue(), 'MAGAZINE TEST');
    const before = await downloadProject(page);
    const file = Buffer.from(before.pages[0].image.split(',')[1], 'base64');
    await page.locator('[data-img="image"]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: file });
    await page.waitForFunction(() => document.querySelector('[data-field="image"]').value.startsWith('data:image/webp'));
    const uploaded = await page.locator('[data-field="image"]').inputValue();
    await page.locator('#undoBtn').click();
    assert.equal(await page.locator('[data-field="image"]').inputValue(), before.pages[0].image);
    await page.locator('#redoBtn').click();
    assert.equal(await page.locator('[data-field="image"]').inputValue(), uploaded);
    await upload(page, { meta: before.meta, pages: [before.pages[0]] });
    assert.equal(await page.locator('.issue-item').count(), 1);
    await page.locator('#undoBtn').click();
    assert.equal(await page.locator('.issue-item').count(), 12);
    await page.locator('#redoBtn').click();
    assert.equal(await page.locator('.issue-item').count(), 1);
  });
  await scenario('Complément : traduction personnelle conservée après rechargement', async page => {
    const project = await downloadProject(page);
    project.pages[0].title = 'UNE COUVERTURE PERSONNELLE';
    project.pages[0].translations = { pt: { title: 'MINHA CAPA' } };
    await upload(page, project);
    await page.waitForTimeout(600);
    await page.reload();
    await page.locator('#languagePicker').selectOption('pt');
    assert.equal(await page.locator('[data-field="title"]').inputValue(), 'MINHA CAPA');
    await page.locator('#languagePicker').selectOption('en');
    assert.equal(await page.locator('[data-field="title"]').inputValue(), 'UNE COUVERTURE PERSONNELLE');
  });
  await browser.close();
  fs.writeFileSync(path.join(output, process.env.TEST_FILTER ? 'resultats-complements.json' : 'resultats.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  const failures = results.filter(r => !r.ok);
  console.log(`${results.length - failures.length}/${results.length} scénarios réussis`);
  if (failures.length) process.exitCode = 1;
})().catch(async e => { console.error(e); await browser?.close(); process.exitCode = 1; });
