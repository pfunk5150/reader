import 'core-js/actual/promise/with-resolvers';
import _ from 'lodash';
import { TextItem } from 'pdfjs-dist/types/src/display/api';
const pPdfjs = import('pdfjs-dist');


function stdDev(numbers: number[]) {
    const mean = _.mean(numbers);
    const squareDiffs = numbers.map((num) => Math.pow(num - mean, 2));
    const avgSquareDiff = _.mean(squareDiffs);
    return Math.sqrt(avgSquareDiff);
}
function isRotatedByAtLeast35Degrees(transform: [number, number, number, number, number, number]): boolean {
    const [a, b, c, d, _e, _f] = transform;

    // Calculate the rotation angles using arctan(b/a) and arctan(-c/d)
    const angle1 = Math.atan2(b, a) * (180 / Math.PI); // from a, b
    const angle2 = Math.atan2(-c, d) * (180 / Math.PI); // from c, d

    // Either angle1 or angle2 can be used to determine the rotation, they should be equivalent
    const rotationAngle1 = Math.abs(angle1);
    const rotationAngle2 = Math.abs(angle2);

    // Check if the absolute rotation angle is greater than or equal to 35 degrees
    return rotationAngle1 >= 35 || rotationAngle2 >= 35;
}

async function main() {
    const pdfjs = await pPdfjs;

    const loadingTask = pdfjs.getDocument({
        url: process.argv[2],
        disableFontFace: true,
    });

    const doc = await loadingTask.promise;
    const meta = await doc.getMetadata();

    const textItems: TextItem[][] = [];

    for (const pg of _.range(0, doc.numPages)) {
        const page = await doc.getPage(pg + 1);
        const textContent = await page.getTextContent();
        textItems.push((textContent.items as TextItem[]));

    }

    const articleCharHeights = [];
    for (const textItem of textItems.flat()) {
        if (textItem.height) {
            articleCharHeights.push(...Array(textItem.str.length).fill(textItem.height));
        }
    }
    const articleAvgHeight = _.mean(articleCharHeights);
    const articleStdDevHeight = stdDev(articleCharHeights);
    // const articleMedianHeight = articleCharHeights.sort()[Math.floor(articleCharHeights.length / 2)];
    const mdOps: Array<{
        text: string;
        op?: 'new' | 'append';
        mode: 'h1' | 'h2' | 'p' | 'appendix' | 'space';
    }> = [];


    let op: 'append' | 'new' = 'new';
    let mode: 'h1' | 'h2' | 'p' | 'space' | 'appendix' = 'p';
    for (const pageTextItems of textItems) {
        const charHeights = [];
        for (const textItem of pageTextItems as TextItem[]) {
            if (textItem.height) {
                charHeights.push(...Array(textItem.str.length).fill(textItem.height));
            }
        }

        const avgHeight = _.mean(charHeights);
        const stdDevHeight = stdDev(charHeights);
        // const medianHeight = charHeights.sort()[Math.floor(charHeights.length / 2)];

        for (const textItem of pageTextItems) {
            if (textItem.height > articleAvgHeight + 3 * articleStdDevHeight) {
                mode = 'h1';
            } else if (textItem.height > articleAvgHeight + 2 * articleStdDevHeight) {
                mode = 'h2';
            } else if (textItem.height && textItem.height < avgHeight - stdDevHeight) {
                mode = 'appendix';
            } else if (textItem.height) {
                mode = 'p';
            } else {
                mode = 'space';
            }

            if (isRotatedByAtLeast35Degrees(textItem.transform as any)) {
                mode = 'appendix';
            }

            mdOps.push({
                op,
                mode,
                text: textItem.str
            });

            if (textItem.hasEOL && !textItem.str) {
                op = 'new';
            } else {
                op = 'append';
            }
        }
    }


    return { meta, mdOps };
}

main();
