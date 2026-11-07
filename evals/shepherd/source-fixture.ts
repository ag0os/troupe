/**
 * The source fixtures eval tests use: temporary repositories holding a
 * minimal Shepherd source set, and sample paths of its membership. Its
 * module specifier is the only line an extracted copy rewrites.
 */

export {
	FIXTURE_FRAMEWORK_PATH,
	git,
	initShepherdRepo,
	SAMPLE_SOURCE_PATHS,
	TEST_GIT_ENV,
	testGit,
	writeAt,
} from "../../scripts/shepherd-source-fixture";
