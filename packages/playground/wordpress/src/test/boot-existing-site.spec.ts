import { loadNodeRuntime } from '@php-wasm/node';
import { dirname } from '@php-wasm/util';
import { RecommendedPHPVersion } from '@wp-playground/common';
import {
	getSqliteDriverModule,
	getWordPressModule,
} from '@wp-playground/wordpress-builds';
import {
	bootRequestHandler,
	bootWordPress,
	bootWordPressAndRequestHandler,
} from '../boot';

/**
 * A saved site must boot even when its theme or plugins fatal. Otherwise
 * Playground crashes and the user cannot open the file browser to fix it.
 *
 * @see https://github.com/WordPress/wordpress-playground/issues/3243
 */
describe('Booting an existing site', () => {
	it('should not load the active theme or plugins', async () => {
		const databasePath = '/wordpress/wp-content/database/.ht.sqlite';
		const options = {
			createPhpRuntime: () => loadNodeRuntime(RecommendedPHPVersion),
			siteUrl: 'http://playground.test',
			wordPressZip: await getWordPressModule(),
			sqliteIntegrationPluginZip: await getSqliteDriverModule(),
			dataSqlPath: databasePath,
		};
		await using saved = await bootWordPressAndRequestHandler(options);
		const source = await saved.getPrimaryPhp();
		const database = source.readFileAsBuffer(databasePath);
		const theme = (
			await source.run({
				code: `<?php
ob_start();
require '/wordpress/wp-load.php';
ob_clean();
echo get_stylesheet();
`,
			})
		).text;
		expect(theme).not.toBe('');

		await using reopened = await bootRequestHandler(options);
		await bootWordPress(reopened, {
			...options,
			wordpressInstallMode: 'install-from-existing-files-if-needed',
			hooks: {
				beforeDatabaseSetup: async (php) => {
					php.mkdir(dirname(databasePath));
					php.writeFile(databasePath, database);
					// The syntax error reported in the issue.
					php.writeFile(
						`/wordpress/wp-content/themes/${theme}/functions.php`,
						'<?php function broken_function( ...) {}'
					);
					php.mkdir('/wordpress/wp-content/mu-plugins');
					php.writeFile(
						'/wordpress/wp-content/mu-plugins/broken.php',
						'<?php throw new Exception("A saved plugin failed");'
					);
				},
			},
		});

		// The site still fatals, but Playground is available to repair it.
		const response = await reopened.request({ url: '/' });
		expect(response.httpStatusCode).toBe(500);
	}, 60_000);
});
