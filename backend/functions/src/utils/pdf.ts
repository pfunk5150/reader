import 'core-js/actual/promise/with-resolvers';
import _ from 'lodash';
import { TextItem } from 'pdfjs-dist/types/src/display/api';
const pPdfjs = import('pdfjs-dist');

async function main() {
    const pdfjs = await pPdfjs;

    const loadingTask = pdfjs.getDocument({
        url: process.argv[2],
        enableXfa: true,
    });

    const doc = await loadingTask.promise;
    const meta = await doc.getMetadata();

    console.log(doc.numPages);
    console.log(meta);

    for (const pg of _.range(0, doc.numPages)) {
        const page = await doc.getPage(pg + 1);
        const textContent = await page.getTextContent({ includeMarkedContent: true });
        const anno = await page.getAnnotations();
        const stree = await page.getStructTree();
        const ops = await page.getOperatorList();
        const xfa = await page.getXfa();
        const text = textContent.items.map((x) => (x as TextItem).str).join(' ');
        console.log([text, anno, stree, ops, xfa]);
    }

}

main();
